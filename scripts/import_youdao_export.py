#!/usr/bin/env python3
"""Offline, transactional import of a readable Youdao export (stdlib only).

Only 导出清单/报告/异常, 元数据/文件夹.json, 可阅读导出 and 附件 are read.
原始备份, databases and encrypted source bodies are never opened. The backend
must be stopped for --apply. --dry-run changes no vault files. See --help.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import html
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import socket
import sys
import tempfile
import urllib.parse
import uuid


VERSION = 1
REPORT_FILES = ("导出报告.txt", "导出清单.json", "导出清单.csv", "异常清单.json", "元数据/文件夹.json")
ID_PATTERN = re.compile(r"[A-Za-z0-9-]{1,80}\Z")
LINK = re.compile(r"(!?\[[^\]\n]*\]\(\s*)(?:<([^>\n]+)>|([^\s)]+))")
DEFINITION = re.compile(r"^(\s{0,3}\[[^\]\n]+\]:\s*)(?:<([^>\n]+)>|(\S+))", re.M)
ATTRIBUTE = re.compile(r"(\b(?:href|src)\s*=\s*)([\"'])(.*?)\2", re.I)


class ImportFailure(Exception):
    pass


def check(ok, message):
    if not ok:
        raise ImportFailure(message)


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def no_symlinks(path):
    path = path.absolute()
    for part in [path, *path.parents]:
        check(not part.is_symlink(), f"拒绝符号链接：{part}")


def safe_relative(value):
    check(isinstance(value, str) and value and "\x00" not in value and "\\" not in value,
          f"无效相对路径：{value!r}")
    path = PurePosixPath(value)
    check(not path.is_absolute() and ".." not in path.parts and ":" not in path.parts[0],
          f"拒绝越界路径：{value}")
    return path


def beneath(root, relative, *, exists=False):
    relative = safe_relative(relative)
    path = root.joinpath(*relative.parts)
    no_symlinks(path)
    check(path.resolve().is_relative_to(root.resolve()), f"路径越界：{relative}")
    if exists:
        check(path.is_file(), f"缺少文件：{path}")
    return path


def walk_files(root):
    no_symlinks(root)
    if not root.exists():
        return []
    result = []
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            no_symlinks(Path(base) / name)
        result.extend(Path(base) / name for name in files)
    return sorted(result)


def iso_time(value):
    if value in (None, "", 0):
        return None
    try:
        timestamp = float(value)
        if timestamp > 100_000_000_000:
            timestamp /= 1000
        return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")
    except (ValueError, TypeError, OverflowError):
        raise ImportFailure(f"无效来源时间戳：{value!r}")


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def title_of(row):
    return re.sub(r"\.note$", "", row["title"], flags=re.I)


def destination(row):
    category = "回收站" if row["trashed"] else "笔记"
    path = safe_relative(row["markdown"])
    prefix = PurePosixPath("可阅读导出") / category
    check(path.is_relative_to(prefix) and path.suffix.lower() == ".md",
          f"记录目录与回收状态不一致：{row['id']}")
    return str(PurePosixPath("有道") / category / path.relative_to(prefix))


def placeholder(row):
    if row["status"] == "encrypted":
        explanation = "此笔记已加密上锁。本知识库仅保留占位信息，没有读取、解密或导入加密正文。"
    else:
        explanation = "此笔记的原始正文缺失。本知识库仅保留占位信息，导出中的搜索缓存未被当作完整正文导入。"
    return (f"# {title_of(row)}\n\n> 来源状态：{row['status']}（非完整正文）\n\n"
            f"{explanation}\n\n此记录不参与 AI 回答取证。请回到有道核对来源后重新导出。\n\n"
            f"- 有道笔记 ID：`{row['id']}`\n- 可阅读导出路径：`{row['markdown']}`\n")


class Source:
    def __init__(self, root):
        no_symlinks(root)
        self.root = root.resolve()
        check(self.root.is_dir(), "导出目录不存在")
        self.rows = load_json(beneath(self.root, "导出清单.json", exists=True))
        check(isinstance(self.rows, list) and self.rows, "导出清单必须为非空数组")
        self.export_report = beneath(self.root, "导出报告.txt", exists=True).read_text(encoding="utf-8-sig")
        self.anomalies = load_json(beneath(self.root, "异常清单.json", exists=True))
        check(isinstance(self.anomalies, list), "异常清单必须为数组")
        self.folders = load_json(beneath(self.root, "元数据/文件夹.json", exists=True))
        check(isinstance(self.folders, list), "文件夹清单必须为数组")
        self.by_id, self.by_path, self.documents = {}, {}, {}
        for row in self.rows:
            check(isinstance(row, dict), "导出记录必须为对象")
            rid = row.get("id")
            check(isinstance(rid, str) and ID_PATTERN.fullmatch(rid), f"无效笔记ID：{rid!r}")
            check(rid not in self.by_id, f"重复笔记ID：{rid}")
            check(row.get("status") in ("ok", "missing_body", "encrypted"), f"未知来源状态：{rid}")
            check(type(row.get("trashed")) is bool, f"回收站标记必须为布尔值：{rid}")
            check(isinstance(row.get("title"), str), f"缺少标题：{rid}")
            check(not row.get("encrypted") or row["status"] == "encrypted", f"加密标记与状态矛盾：{rid}")
            destination(row)
            for kind in ("markdown", "html"):
                rel = str(safe_relative(row[kind]))
                check(rel.startswith("可阅读导出/"), f"禁止读取可阅读导出之外的正文：{rel}")
                check(rel not in self.by_path, f"多个ID使用同一导出文件：{rel}")
                path = beneath(self.root, rel, exists=True)
                content = path.read_bytes()
                self.documents[rel] = {"sha256": sha(content), "bytes": len(content)}
                self.by_path[rel] = rid
            self.by_id[rid] = row
            iso_time(row.get("createTime")); iso_time(row.get("modifyTime"))
        self.report_copies = {}
        for rel in REPORT_FILES:
            path = beneath(self.root, rel, exists=True)
            self.report_copies[rel] = {"sha256": file_hash(path), "bytes": path.stat().st_size}
        self.asset_files = {}
        for path in walk_files(self.root / "附件"):
            rel = path.relative_to(self.root).as_posix()
            self.asset_files[rel] = {"sha256": file_hash(path), "bytes": path.stat().st_size}
        check((self.root / "附件").is_dir(), "附件目录不存在")
        self.directories = []
        for category in ("笔记", "回收站"):
            base = self.root / "可阅读导出" / category
            no_symlinks(base)
            check(base.is_dir(), f"缺少可阅读目录：{category}")
            for parent, dirs, files in os.walk(base, followlinks=False):
                no_symlinks(Path(parent))
                for name in dirs + files:
                    no_symlinks(Path(parent) / name)
                self.directories.append(str(PurePosixPath("有道") / category / Path(parent).relative_to(base)))
        self.anomalies_by_id = {}
        for anomaly in self.anomalies:
            if isinstance(anomaly, dict):
                self.anomalies_by_id.setdefault(anomaly.get("note_id"), []).append(anomaly)

    def record(self, row):
        rid = row["id"]
        target = destination(row)
        original = beneath(self.root, row["markdown"], exists=True).read_text(encoding="utf-8-sig")
        references, warnings = [], []

        def rewrite_url(raw):
            value = html.unescape(raw)
            try:
                parsed = urllib.parse.urlsplit(value)
            except ValueError:
                warnings.append({"kind": "invalid_url", "url": raw})
                return raw
            target_id = None
            if parsed.scheme or parsed.netloc:
                if parsed.hostname == "note.youdao.com":
                    tokens = re.findall(r"[A-Za-z0-9-]+", urllib.parse.unquote(value))
                    candidates = {token for token in tokens if token in self.by_id}
                    if len(candidates) == 1:
                        target_id = candidates.pop()
                if target_id is None:
                    references.append({"kind": "external", "url": raw})
                    return raw
                resolved = destination(self.by_id[target_id])
            else:
                if not parsed.path:
                    return raw
                decoded = urllib.parse.unquote(parsed.path)
                if "\\" in decoded or "\x00" in decoded:
                    warnings.append({"kind": "invalid_local_reference", "url": raw})
                    return raw
                local = (self.root / row["markdown"]).parent.joinpath(decoded).resolve()
                if not local.is_relative_to(self.root):
                    warnings.append({"kind": "outside_export_reference", "url": raw})
                    return raw
                rel = local.relative_to(self.root).as_posix()
                if rel in self.asset_files:
                    resolved = "assets/youdao-export/" + rel
                    references.append({"kind": "asset", "sourcePath": rel,
                                       "sha256": self.asset_files[rel]["sha256"]})
                elif rel in self.by_path:
                    target_id = self.by_path[rel]
                    resolved = destination(self.by_id[target_id])
                else:
                    inspectable = rel.startswith(("可阅读导出/", "附件/"))
                    warnings.append({"kind": "unmapped_local_reference", "url": raw, "path": rel,
                                     "exists": local.is_file() if inspectable else None})
                    return raw
            if target_id:
                references.append({"kind": "note", "targetId": target_id,
                                   "targetTrashed": self.by_id[target_id]["trashed"]})
            relative = os.path.relpath(resolved, str(PurePosixPath(target).parent)).replace(os.sep, "/")
            result = urllib.parse.quote(relative, safe="/-._~")
            if parsed.query and not (parsed.scheme or parsed.netloc):
                result += "?" + parsed.query
            if parsed.fragment and not target_id:
                result += "#" + parsed.fragment
            elif parsed.fragment and not (parsed.scheme or parsed.netloc):
                result += "#" + parsed.fragment
            return result

        def inline(text):
            def md_replace(match):
                angle = match.group(2) is not None
                raw = match.group(2) if angle else match.group(3)
                rewritten = rewrite_url(raw)
                return match.group(1) + ("<" + rewritten + ">" if angle else rewritten)
            def attr_replace(match):
                return match.group(1) + match.group(2) + rewrite_url(match.group(3)) + match.group(2)
            def prose(value):
                return ATTRIBUTE.sub(attr_replace, DEFINITION.sub(md_replace, LINK.sub(md_replace, value)))
            # Match exact backtick-run lengths, including code containing a shorter
            # backtick run. Never treat Markdown examples as actual attachment URLs.
            chunks, cursor = [], 0
            while True:
                opening = re.search(r"`+", text[cursor:])
                if not opening:
                    chunks.append(prose(text[cursor:])); break
                start, end = cursor + opening.start(), cursor + opening.end()
                closing = re.compile(r"(?<!`)`{" + str(end-start) + r"}(?!`)").search(text, end)
                if not closing:
                    chunks.append(prose(text[cursor:])); break
                chunks.extend([prose(text[cursor:start]), text[start:closing.end()]])
                cursor = closing.end()
            return "".join(chunks)

        output, fence = [], None
        if row["status"] == "ok":
            for line in original.splitlines(keepends=True):
                marker = re.match(r"^\s{0,3}(?:>\s*)*(`{3,}|~{3,})", line)
                if marker:
                    value = marker.group(1)
                    if fence is None:
                        fence = value
                    elif value[0] == fence[0] and len(value) >= len(fence):
                        fence = None
                    output.append(line)
                else:
                    indented = line.startswith(("    ", "\t"))
                    output.append(line if fence or indented else inline(line))
            body = "".join(output)
        else:
            body = placeholder(row)
        linked_assets = {r["sourcePath"]: r["sha256"] for r in references if r["kind"] == "asset"}
        source_digest = sha(canonical({"version": VERSION, "record": row,
                                      "markdown": self.documents[row["markdown"]]["sha256"],
                                      "html": self.documents[row["html"]]["sha256"], "assets": linked_assets}))
        content = body.encode("utf-8")
        meta = {"id": rid, "path": target, "title": title_of(row),
                "sourceId": rid, "sourceUrl": f"https://note.youdao.com/web/#/file/recent/note/{rid}/",
                "sourceStatus": row["status"], "sourceCreatedAt": iso_time(row.get("createTime")),
                "sourceModifiedAt": iso_time(row.get("modifyTime")), "sourceExportPath": row["markdown"],
                "sourceHtmlPath": "assets/youdao-export/" + row["html"],
                "fingerprint": "youdao-export:" + source_digest, "lastHash": sha(content), "fileKey": "",
                "deleted": row["trashed"], "deletedAt": iso_time(row.get("modifyTime")) if row["trashed"] else None}
        return {"id": rid, "status": row["status"], "trashed": row["trashed"], "path": target,
                "sourceDigest": source_digest, "sourceMarkdownSha256": self.documents[row["markdown"]]["sha256"],
                "sourceHtmlSha256": self.documents[row["html"]]["sha256"], "importedSha256": sha(content),
                "assetReferences": linked_assets, "references": references,
                "warnings": warnings, "exportAnomalies": self.anomalies_by_id.get(rid, []),
                "_content": content, "_meta": meta}


def metadata_file(home, meta):
    return beneath(home, ".trash/" + meta["id"] + ".md" if meta.get("deleted") else "vault/" + meta["path"])


def make_plan(source, home, archive_name, legacy_ids=None):
    legacy_ids = set(legacy_ids or ())
    no_symlinks(home)
    home = home.resolve()
    check(home.is_dir(), "VAULT_HOME目录不存在；先初始化应用或建立空目录")
    check(not home.is_relative_to(source.root) and not source.root.is_relative_to(home), "源导出与知识库不得相互嵌套")
    safe_relative(archive_name)
    check("/" not in archive_name, "归档名称不能含目录分隔符")
    index_file = beneath(home, ".metadata/index.json")
    original_index = load_json(index_file) if index_file.exists() else []
    check(isinstance(original_index, list), "现有索引必须为数组")
    by_source, by_id = {}, {}
    for meta in original_index:
        check(meta.get("id") not in by_id and ID_PATTERN.fullmatch(meta.get("id", "")), "现有索引包含重复或无效ID")
        metadata_file(home, meta)
        by_id[meta["id"]] = meta
        if meta.get("sourceId"):
            by_source.setdefault(meta["sourceId"], []).append(meta)
    state_path = beneath(home, f"imports/{archive_name}/state.json")
    state = load_json(state_path) if state_path.exists() else {"version": VERSION, "records": {}, "assets": {}}
    check(state.get("version") == VERSION, "导入状态版本不支持，请先升级导入器")
    records, conflicts = [], []
    final_metadata = {m["id"]: dict(m) for m in original_index}
    old_paths = []
    legacy_report_path = beneath(home, "imports/youdao-report.json")
    legacy_report = load_json(legacy_report_path) if legacy_report_path.exists() else {}
    legacy_hashes, legacy_records = {}, {}
    for item in legacy_report.get("notes", []):
        if item.get("sourceId"):
            legacy_hashes[item["sourceId"]] = item.get("markdownSha256")
            legacy_records[item["sourceId"]] = item
    for row in source.rows:
        record = source.record(row)
        rid = row["id"]
        existing = by_source.get(rid, [])
        if not existing and rid in by_id:
            existing = [by_id[rid]]
        previous = state.get("records", {}).get(rid)
        reason = None
        id_owner = by_id.get(rid)
        if id_owner and id_owner.get("sourceId") != rid:
            reason = "目标app ID已属于另一来源或普通笔记，拒绝覆盖索引"
        elif id_owner and existing and all(m["id"] != id_owner["id"] for m in existing):
            reason = "目标app ID与同来源记录发生交叉冲突，拒绝覆盖索引"
        elif len(existing) > 1:
            reason = "现有知识库含多个同sourceId笔记，需人工处理"
        elif previous:
            if not existing:
                reason = "导入状态存在但现有索引没有来源记录，拒绝复活或覆盖"
            elif previous["sourceDigest"] != record["sourceDigest"]:
                reason = "来源内容或附件已变化；保留现有版本，需人工合并"
            else:
                actual = metadata_file(home, existing[0])
                if not actual.is_file():
                    reason = "现有来源笔记文件缺失，拒绝自动重建"
                else:
                    record["currentSha256"] = file_hash(actual)
                    record["action"] = "skip_user_edited" if record["currentSha256"] != previous["importedSha256"] else "skip_identical"
                    record["currentPath"] = existing[0]["path"]
                    records.append(record)
                    continue
        elif existing:
            current = existing[0]
            actual = metadata_file(home, current)
            expected = legacy_hashes.get(rid)
            legacy = legacy_records.get(rid, {})
            if rid not in legacy_ids:
                reason = "已有同来源记录，但无本导入器状态，不自动替换"
            elif current.get("deleted") or not actual.is_file() or not expected or file_hash(actual) != expected:
                reason = "旧来源笔记正文与原导入报告hash不一致或已删除；保留用户版本"
            elif current.get("title") != legacy.get("title") or current.get("path") not in legacy.get("notePaths", []):
                reason = "旧来源笔记标题或目录已被修改；保留用户版本"
            else:
                record["action"] = "replace_verified_legacy"
                old_paths.append(actual.relative_to(home).as_posix())
                final_metadata.pop(current["id"], None)
        if reason:
            record["action"] = "conflict"
            conflicts.append({"id": rid, "reason": reason})
        else:
            target = metadata_file(home, record["_meta"])
            if target.exists() and target.relative_to(home).as_posix() not in old_paths:
                record["action"] = "conflict"
                conflicts.append({"id": rid, "reason": "目标文件已存在，拒绝覆盖"})
            else:
                record.setdefault("action", "import")
                final_metadata[rid] = record["_meta"]
        records.append(record)
    for rel, info in source.asset_files.items():
        target = beneath(home, "vault/assets/youdao-export/" + rel)
        if target.exists() and file_hash(target) != info["sha256"]:
            conflicts.append({"asset": rel, "reason": "目标附件与来源哈希不同，拒绝覆盖"})
    for rel, info in {**source.documents, **source.report_copies}.items():
        target_rel = ("vault/assets/youdao-export/" + rel if rel in source.documents and rel.endswith(".html")
                      else f"imports/{archive_name}/" + rel)
        target = beneath(home, target_rel)
        if target.exists() and file_hash(target) != info["sha256"]:
            conflicts.append({"archiveFile": rel, "reason": "已有原格式归档与本次来源不同，拒绝覆盖"})
    all_existing = walk_files(home)
    existing_bytes = sum(path.stat().st_size for path in all_existing)
    source_bytes = sum(i["bytes"] for i in source.asset_files.values()) + sum(i["bytes"] for i in source.documents.values())
    required = existing_bytes + source_bytes + sum(len(r["_content"]) for r in records) + 64 * 1024 * 1024
    available = shutil.disk_usage(home.parent).free
    check(available >= required, f"暂存空间不足：需要约{required}字节，可用{available}字节")
    original_files = {path.relative_to(home).as_posix(): file_hash(path) for path in all_existing}
    counts = Counter((r["status"], r["trashed"]) for r in records)
    report = {"version": VERSION, "createdAt": now(), "sourceDirectory": str(source.root), "vaultHome": str(home),
              "archiveName": archive_name, "dryRun": True, "committed": False,
              "counts": {"records": len(records), "active": sum(not r["trashed"] for r in records),
                         "trash": sum(r["trashed"] for r in records),
                         "byStatusAndTrash": [{"status": s, "trashed": t, "count": n} for (s,t),n in sorted(counts.items())],
                         "actions": dict(Counter(r["action"] for r in records)), "assets": len(source.asset_files),
                         "assetBytes": sum(i["bytes"] for i in source.asset_files.values()),
                         "htmlAssetCopies": len(source.rows),
                         "sourceFolderRecords": len(source.folders), "mirroredDirectories": len(source.directories),
                         "exportAnomalies": len(source.anomalies)},
              "capacity": {"requiredFreeBytes": required, "availableBytes": available},
              "conflicts": conflicts, "records": [{k:v for k,v in r.items() if not k.startswith("_")} for r in records],
              "assets": source.asset_files, "originalBackupRead": False}
    return {"source": source, "home": home, "archive": archive_name, "records": records,
            "metadata": list(final_metadata.values()), "originalIndex": original_index,
            "state": state, "oldPaths": old_paths, "originalFiles": original_files, "report": report}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    no_symlinks(path)
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    with temporary.open("x", encoding="utf-8") as handle:
        os.chmod(temporary, 0o600)
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n"); handle.flush(); os.fsync(handle.fileno())
    os.replace(temporary, path)


def verified_copy(source, target, expected):
    target.parent.mkdir(parents=True, exist_ok=True)
    no_symlinks(target)
    shutil.copy2(source, target)
    check(file_hash(target) == expected and file_hash(source) == expected, f"复制校验失败或来源期间变化：{source}")


@contextmanager
def offline_lock(work, port):
    work.mkdir(parents=True, exist_ok=True)
    no_symlinks(work); os.chmod(work, 0o700)
    (work / ".gitignore").write_text("*\n", encoding="utf-8")
    with (work / "import.lock").open("a+") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ImportFailure("已有离线导入任务在运行") from error
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as guard:
            guard.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                guard.bind(("127.0.0.1", port)); guard.listen(1)
            except OSError as error:
                raise ImportFailure(f"无法独占本机端口{port}；请停止后端后重试（或检查运行权限）：{error}") from error
            yield


def apply_plan(plan, work, port=8787, fail_after_backup=False):
    home, source = plan["home"], plan["source"]
    check(not plan["report"]["conflicts"], "存在冲突；未修改知识库。请查看报告")
    no_symlinks(work)
    work = work.resolve()
    check(not work.is_relative_to(home) and not home.is_relative_to(work), "事务目录必须在知识库外部")
    check(not work.is_relative_to(source.root) and not source.root.is_relative_to(work), "事务目录必须在源导出之外")
    with offline_lock(work, port):
        check(os.stat(home).st_dev == os.stat(work).st_dev, "事务目录必须与知识库位于同一文件系统以支持原子重命名")
        current = {p.relative_to(home).as_posix(): file_hash(p) for p in walk_files(home)}
        check(current == plan["originalFiles"], "知识库在预检后发生变化；未修改，请重新预检")
        transaction = work / (datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8])
        transaction.mkdir(mode=0o700)
        stage, backup = transaction / "staged-data", transaction / "original-data"
        journal = {"createdAt": now(), "vaultHome": str(home), "backup": str(backup), "stage": str(stage), "phase": "staging"}
        write_json(transaction / "journal.json", journal)
        swapped = False
        try:
            shutil.copytree(home, stage, copy_function=shutil.copy2, symlinks=True)
            walk_files(stage)  # Reject a symlink introduced after preflight, without following it.
            for rel in plan["oldPaths"]:
                beneath(stage, rel, exists=True).unlink()
            for directory in source.directories:
                beneath(stage, "vault/" + directory).mkdir(parents=True, exist_ok=True)
            for rel, info in source.asset_files.items():
                target = beneath(stage, "vault/assets/youdao-export/" + rel)
                if not target.exists():
                    verified_copy(beneath(source.root, rel, exists=True), target, info["sha256"])
                else:
                    check(file_hash(target) == info["sha256"], f"暂存附件冲突：{rel}")
            archive = beneath(stage, "imports/" + plan["archive"])
            for rel, info in {**source.documents, **source.report_copies}.items():
                target = (beneath(stage, "vault/assets/youdao-export/" + rel)
                          if rel in source.documents and rel.endswith(".html") else beneath(archive, rel))
                if target.exists() and file_hash(target) != info["sha256"]:
                    raise ImportFailure(f"原格式归档发生变化，拒绝覆盖：{rel}")
                if not target.exists():
                    verified_copy(beneath(source.root, rel, exists=True), target, info["sha256"])
            new_state = dict(plan["state"])
            new_state["version"] = VERSION; new_state["sourceDirectory"] = str(source.root)
            new_state["assets"] = source.asset_files; new_state["records"] = dict(new_state.get("records", {}))
            for record in plan["records"]:
                if record["action"].startswith("skip_"):
                    continue
                path = metadata_file(stage, record["_meta"])
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("xb") as handle:
                    handle.write(record["_content"]); handle.flush(); os.fsync(handle.fileno())
                modified = record["_meta"]["sourceModifiedAt"]
                if modified:
                    timestamp = datetime.fromisoformat(modified.replace("Z", "+00:00")).timestamp()
                    os.utime(path, (timestamp, timestamp))
                check(file_hash(path) == record["importedSha256"], f"暂存正文哈希错误：{record['id']}")
                new_state["records"][record["id"]] = {key: record[key] for key in
                    ("sourceDigest", "importedSha256", "sourceMarkdownSha256", "sourceHtmlSha256", "path", "status", "trashed")}
            write_json(stage / ".metadata/index.json", plan["metadata"])
            write_json(archive / "state.json", new_state)
            plan["report"]["dryRun"] = False
            plan["report"]["backupDirectory"] = str(backup)
            plan["report"]["transactionDirectory"] = str(transaction)
            plan["report"]["committed"] = True
            write_json(archive / "import-report.json", plan["report"])
            # Verify every preserved file; imported files intentionally replace only
            # the explicitly verified legacy sample and the index/state/report.
            replaceable = set(plan["oldPaths"]) | {".metadata/index.json", f"imports/{plan['archive']}/state.json", f"imports/{plan['archive']}/import-report.json"}
            for rel, digest in plan["originalFiles"].items():
                if rel not in replaceable:
                    check(file_hash(beneath(stage, rel, exists=True)) == digest, f"现有文件保留校验失败：{rel}")
            latest = {p.relative_to(home).as_posix(): file_hash(p) for p in walk_files(home)}
            check(latest == plan["originalFiles"], "暂存期间原知识库被外部编辑器修改；拒绝切换，请重新预检")
            journal["phase"] = "ready"; write_json(transaction / "journal.json", journal)
            # No server can start on the reserved port during this short two-rename
            # transaction. The original tree remains intact as a permanent backup.
            os.replace(home, backup)
            journal["phase"] = "original_backed_up"; write_json(transaction / "journal.json", journal)
            if fail_after_backup:
                raise OSError("injected rollback test")
            os.replace(stage, home); swapped = True
            journal["phase"] = "committed"; journal["finishedAt"] = now()
            write_json(transaction / "journal.json", journal)
            write_json(transaction / "import-report.json", plan["report"])
            return plan["report"]
        except BaseException:
            if not swapped and backup.exists() and not home.exists():
                os.replace(backup, home)
                journal["phase"] = "rolled_back"
            elif swapped:
                journal["phase"] = "committed_report_write_failed"
            else:
                journal["phase"] = "staging_failed"
            plan["report"]["committed"] = swapped
            try:
                write_json(transaction / "journal.json", journal)
            finally:
                if not swapped and stage.exists():
                    shutil.rmtree(stage)
            raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--vault-home", required=True, type=Path)
    parser.add_argument("--archive-name", default="youdao-export")
    parser.add_argument("--work-dir", type=Path, help="同文件系统、知识库外的暂存/备份目录；默认项目根.youdao-migration")
    parser.add_argument("--report", required=True, type=Path, help="独立JSON报告路径，不能位于源导出内")
    parser.add_argument("--replace-legacy-source", action="append", default=None,
                        help="显式允许替换的旧来源sourceId，可重复；仍须通过原导入报告的正文hash、标题和目录校验")
    parser.add_argument("--server-port", type=int, default=8787)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    try:
        check(1 <= args.server_port <= 65535, "无效服务端口")
        check(not args.report.resolve().is_relative_to(args.source.resolve()), "报告不能写入只读源导出目录")
        check(not args.report.resolve().is_relative_to(args.vault_home.resolve()), "独立报告必须位于知识库之外")
        source = Source(args.source)
        plan = make_plan(source, args.vault_home, args.archive_name, args.replace_legacy_source)
        write_json(args.report, plan["report"])
        print(json.dumps({"dryRun": args.dry_run, "counts": plan["report"]["counts"],
                          "conflicts": len(plan["report"]["conflicts"]), "report": str(args.report)}, ensure_ascii=False))
        if plan["report"]["conflicts"]:
            return 2
        if args.apply:
            work = args.work_dir or args.vault_home.resolve().parent / ".youdao-migration"
            result = apply_plan(plan, work, args.server_port)
            write_json(args.report, result)
            print(json.dumps({"committed": True, "backupDirectory": result["backupDirectory"]}, ensure_ascii=False))
        return 0
    except (ImportFailure, OSError, ValueError, KeyError, TypeError) as error:
        print(f"IMPORT FAILED: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
