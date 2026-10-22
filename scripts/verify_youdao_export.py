#!/usr/bin/env python3
"""Independent read-only audit of a readable Youdao export migration.

Reads the readable export, attachment tree, pre-import checksum baseline, actual
vault/index and original-data backup. Never imports importer code, starts a
server, visits a URL, reads 原始备份 or writes into any input directory.
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import html
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import urllib.parse

INLINE_START = re.compile(r"!?\[(?:\\.|[^\]\\\n])*\]\(\s*")
REFERENCE_START = re.compile(r"^ {0,3}\[(?:\\.|[^\]\\\n])+\]:[ \t]*", re.M)
HTML_ATTRIBUTE = re.compile(r"\b(?:href|src)\s*=\s*([\"'])(.*?)\1", re.I)


def assert_plain(path):
    path = Path(path).absolute()
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError(f"拒绝符号链接：{part}")
    return path


def inside(root, relative):
    relative = PurePosixPath(relative)
    if relative.is_absolute() or ".." in relative.parts or "\\" in str(relative):
        raise ValueError("输入清单含越界路径")
    result = assert_plain(root.joinpath(*relative.parts))
    if not result.resolve().is_relative_to(root.resolve()):
        raise ValueError("输入路径越界")
    return result


def digest(path):
    assert_plain(path)
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def files(root, *, exclude_assets=False):
    assert_plain(root)
    result = []
    if not root.exists():
        return result
    for parent, directories, filenames in os.walk(root, followlinks=False):
        for name in directories + filenames:
            assert_plain(Path(parent) / name)
        if exclude_assets and Path(parent) == root:
            directories[:] = [name for name in directories if name != "assets"]
        result.extend(Path(parent) / name for name in filenames)
    return sorted(result)


def read_json(path):
    assert_plain(path)
    return json.loads(path.read_text(encoding="utf-8-sig"))


def protected_code(text):
    """Locate blocks/spans, including nested quote fences and multiline code spans."""
    protected = bytearray(len(text))
    fence = None
    offset = 0
    for line in text.splitlines(keepends=True):
        body = re.sub(r"^(?: {0,3}>[ \t]?)+", "", line)
        match = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", body.rstrip("\r\n"))
        was_fenced = fence is not None
        if match:
            marker = match.group(1)
            if fence is None:
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence) and not match.group(2).strip():
                fence = None
        if was_fenced or match or body.startswith(("    ", "\t")):
            protected[offset:offset + len(line)] = b"\1" * len(line)
        offset += len(line)
    at = 0
    while at < len(text):
        opening = re.search(r"`+", text[at:])
        if opening is None:
            break
        start, end = at + opening.start(), at + opening.end()
        at = end
        if protected[start]:
            continue
        closing = re.compile(r"(?<!`)`{" + str(end - start) + r"}(?!`)").search(text, end)
        if closing and not any(protected[end:closing.end()]):
            protected[start:closing.end()] = b"\1" * (closing.end() - start)
            at = closing.end()
    return protected


def destination_span(text, start):
    if start >= len(text):
        return None
    if text[start] == "<":
        end = text.find(">", start + 1)
        return (start + 1, end) if end >= 0 and "\n" not in text[start:end] else None
    end, depth = start, 0
    while end < len(text):
        character = text[end]
        if character == "\\" and end + 1 < len(text):
            end += 2; continue
        if character.isspace():
            break
        if character == "(":
            depth += 1
        elif character == ")":
            if depth == 0:
                break
            depth -= 1
        end += 1
    return (start, end) if end > start else None


def url_spans(text):
    protected = protected_code(text)
    candidates = []
    for pattern in (INLINE_START, REFERENCE_START):
        for match in pattern.finditer(text):
            span = destination_span(text, match.end())
            if span and not any(protected[match.start():span[1]]):
                candidates.append(span)
    for match in HTML_ATTRIBUTE.finditer(text):
        if not any(protected[match.start():match.end()]):
            candidates.append(match.span(2))
    result = []
    for span in sorted(set(candidates)):
        if not result or span[0] >= result[-1][1]:
            result.append(span)
    return result


def skeleton(text, spans):
    pieces, start = [], 0
    for left, right in spans:
        pieces.extend((text[start:left], "<VERIFIED-URL>")); start = right
    pieces.append(text[start:])
    return "".join(pieces)


def local_target(base_relative, value):
    parsed = urllib.parse.urlsplit(html.unescape(value))
    if parsed.scheme or parsed.netloc or not parsed.path:
        return None, parsed
    decoded = urllib.parse.unquote(parsed.path)
    decoded = re.sub(r"\\([\\()<>\[\] ])", r"\1", decoded)
    if decoded.startswith("/") or "\\" in decoded or "\x00" in decoded:
        return None, parsed
    resolved = os.path.normpath(str(PurePosixPath(base_relative).parent / decoded)).replace(os.sep, "/")
    if resolved == ".." or resolved.startswith("../"):
        return None, parsed
    return resolved, parsed


class Audit:
    def __init__(self):
        self.passed = Counter(); self.failed = Counter(); self.failures = []; self.warnings = Counter(); self.metrics = Counter()
    def check(self, condition, category, identifier="", detail=""):
        if condition:
            self.passed[category] += 1
        else:
            self.failed[category] += 1
            self.failures.append({"check": category, "id": identifier, "detail": detail})
        return condition
    def same_file(self, source, target, category, identifier=""):
        if not self.check(source.is_file() and target.is_file(), category + "_exists", identifier):
            return
        self.check(source.stat().st_size == target.stat().st_size and digest(source) == digest(target), category + "_sha256", identifier)
    def report(self):
        return {"verifiedAt": datetime.now(timezone.utc).isoformat(), "readOnly": True,
                "networkRequests": 0, "rawBackupRead": False, "passed": sum(self.passed.values()),
                "failed": sum(self.failed.values()), "checksPassed": dict(self.passed),
                "checksFailed": dict(self.failed), "metrics": dict(self.metrics),
                "warnings": dict(self.warnings), "failures": self.failures}


def verify(source, home, backup, baseline_path, archive_name, expected=None, import_report=None,
           legacy_source_ids=None):
    expected = dict(expected or {})
    legacy_source_ids = set(legacy_source_ids or ())
    source, home, backup = (assert_plain(Path(p)).resolve() for p in (source, home, backup))
    audit = Audit()
    rows = read_json(inside(source, "导出清单.json"))
    metadata = read_json(inside(home, ".metadata/index.json"))
    previous = read_json(inside(backup, ".metadata/index.json"))
    baseline = read_json(Path(baseline_path))
    audit.check(isinstance(rows, list) and isinstance(metadata, list), "manifest_types")
    ids = [row["id"] for row in rows]
    audit.check(len(ids) == len(set(ids)) == expected.get("records", len(rows)), "source_unique_count")
    source_ids = set(ids)
    by_id = {item["id"]: item for item in metadata}
    audit.check(len(by_id) == len(metadata), "index_unique_ids")
    by_source = defaultdict(list)
    for item in metadata:
        if item.get("sourceId"):
            by_source[item["sourceId"]].append(item)
    status_counts = Counter(f"{row['status']}:{'trash' if row['trashed'] else 'active'}" for row in rows)
    active_count = sum(not row["trashed"] for row in rows)
    trash_count = sum(row["trashed"] for row in rows)
    audit.check(dict(status_counts) == expected.get("status_counts", dict(status_counts)), "source_status_counts")
    audit.check(active_count == expected.get("active", active_count), "source_active_count")
    audit.check(trash_count == expected.get("trash", trash_count), "source_trash_count")
    audit.check(source_ids.issubset(by_source), "source_id_coverage")
    audit.metrics.update({"sourceRecords": len(rows), "indexRecords": len(metadata)})
    destinations, source_paths = {}, {}
    for row in rows:
        category = "回收站" if row["trashed"] else "笔记"
        prefix = PurePosixPath("可阅读导出") / category
        relative = PurePosixPath(row["markdown"])
        if not audit.check(relative.is_relative_to(prefix), "source_category", row["id"]):
            continue
        destinations[row["id"]] = str(PurePosixPath("有道") / category / relative.relative_to(prefix))
        source_paths[row["markdown"]] = row["id"]; source_paths[row["html"]] = row["id"]
    asset_files = files(inside(source, "附件"))
    asset_paths = {path.relative_to(source).as_posix(): path for path in asset_files}
    audit.check(len(asset_files) == expected.get("assets", len(asset_files)), "asset_count")
    for relative, file in asset_paths.items():
        audit.same_file(file, inside(home, "vault/assets/youdao-export/" + relative), "asset", relative)
    expected_active_paths, expected_trash_paths = set(), set()
    external_urls = set()
    external_occurrences, external_locations = Counter(), {}
    for row in rows:
        rid = row["id"]; target_path = destinations[rid]
        matches = by_source.get(rid, [])
        if not audit.check(len(matches) == 1 and matches[0]["id"] == rid, "source_id_identity", rid):
            continue
        meta = matches[0]
        audit.check(meta.get("sourceStatus") == row["status"], "source_status", rid)
        audit.check(meta.get("sourceExportPath") == row["markdown"], "source_export_path", rid)
        audit.check(meta.get("path") == target_path and bool(meta.get("deleted")) == row["trashed"], "note_location_metadata", rid)
        html_relative = "assets/youdao-export/" + row["html"]
        audit.check(meta.get("sourceHtmlPath") == html_relative, "html_metadata", rid)
        note_relative = ".trash/" + rid + ".md" if row["trashed"] else "vault/" + target_path
        (expected_trash_paths if row["trashed"] else expected_active_paths).add(note_relative)
        note_file = inside(home, note_relative)
        if not audit.check(note_file.is_file(), "note_file_exists", rid):
            continue
        if row["trashed"]:
            audit.check(not inside(home, "vault/" + target_path).exists(), "trash_not_active_duplicate", rid)
        source_md = inside(source, row["markdown"])
        audit.same_file(source_md, inside(home, "imports/" + archive_name + "/" + row["markdown"]), "original_markdown", rid)
        audit.same_file(inside(source, row["html"]), inside(home, "vault/" + html_relative), "html", rid)
        actual = note_file.read_text(encoding="utf-8")
        audit.check(meta.get("lastHash") == hashlib.sha256(actual.encode()).hexdigest(), "index_body_hash", rid)
        if row["status"] != "ok":
            clean_title = re.sub(r"(?i)\.note$", "", row["title"])
            expected_placeholder = (f"# {clean_title}\n\n"
                f"> 来源状态：{row['status']}（非完整正文）\n\n"
                + ("此笔记已加密上锁。本知识库仅保留占位信息，没有读取、解密或导入加密正文。" if row["status"] == "encrypted"
                   else "此笔记的原始正文缺失。本知识库仅保留占位信息，导出中的搜索缓存未被当作完整正文导入。")
                + f"\n\n此记录不参与 AI 回答取证。请回到有道核对来源后重新导出。\n\n"
                  f"- 有道笔记 ID：`{rid}`\n- 可阅读导出路径：`{row['markdown']}`\n")
            audit.check(actual == expected_placeholder, "placeholder_explicit_only", rid)
            continue
        original = source_md.read_text(encoding="utf-8-sig")
        old_spans, new_spans = url_spans(original), url_spans(actual)
        same_structure = len(old_spans) == len(new_spans) and skeleton(original, old_spans) == skeleton(actual, new_spans)
        audit.check(same_structure, "body_only_destinations_changed", rid)
        if not same_structure:
            continue
        for number, (old_span, new_span) in enumerate(zip(old_spans, new_spans), 1):
            old_url, new_url = original[slice(*old_span)], actual[slice(*new_span)]
            source_target, parsed = local_target(row["markdown"], old_url)
            target_id = None
            if source_target in source_paths:
                target_id = source_paths[source_target]
            elif parsed.hostname == "note.youdao.com":
                # Require an explicit path/hash token equal to an exported ID.
                tokens = set(re.findall(r"[A-Za-z0-9-]+", urllib.parse.unquote(html.unescape(old_url))))
                candidates = tokens & source_ids
                if len(candidates) == 1:
                    target_id = candidates.pop()
            check_id = f"{rid}:{number}"
            if target_id is not None:
                new_target, new_parsed = local_target(meta["path"], new_url)
                audit.check(new_target == destinations[target_id], "note_link_target", check_id)
                target_meta = by_id.get(target_id, {})
                physical = ".trash/" + target_id + ".md" if target_meta.get("deleted") else "vault/" + destinations[target_id]
                audit.check(inside(home, physical).is_file(), "note_link_file", check_id)
                audit.metrics["linksToTrash" if target_meta.get("deleted") else "linksToActiveNotes"] += 1
                if not parsed.scheme and not parsed.netloc:
                    audit.check((parsed.query, parsed.fragment) == (new_parsed.query, new_parsed.fragment), "link_suffix_preserved", check_id)
            elif source_target in asset_paths:
                new_target, new_parsed = local_target(meta["path"], new_url)
                expected_target = "assets/youdao-export/" + source_target
                audit.check(new_target == expected_target, "asset_link_target", check_id)
                audit.check(new_target is not None and inside(home, "vault/" + new_target).is_file(), "asset_link_file", check_id)
                audit.check((parsed.query, parsed.fragment) == (new_parsed.query, new_parsed.fragment), "link_suffix_preserved", check_id)
                audit.metrics["assetLinks"] += 1
            else:
                audit.check(new_url == old_url, "unmapped_or_external_unchanged", check_id)
                if parsed.scheme or parsed.netloc:
                    audit.metrics["externalLinksUnchanged"] += 1
                    external_urls.add(old_url)
                    external_occurrences[(rid, old_url)] += 1
                    source_line = original[:old_span[0]].count("\n") + 1
                    line_text = original.splitlines()[source_line - 1]
                    external_locations[(rid, old_url)] = {"sourceId": rid, "sourceLine": source_line,
                        "nestedMarkdownLikeSyntax": "]([" in line_text and line_text.count("](") > 1}
                elif parsed.path:
                    audit.warnings["preexistingUnmappedLocalLinks"] += 1
                else:
                    audit.metrics["samePageLinks"] += 1
    prior_notes = [item for item in previous if item.get("sourceId") not in legacy_source_ids]
    audit.check(len(prior_notes) == expected.get("preserved", len(prior_notes)), "prior_note_count")
    for item in prior_notes:
        rid = item["id"]; current = by_id.get(rid)
        def stable_metadata(value):
            return {key: field for key, field in (value or {}).items() if key != "fileKey" and field is not None}
        audit.check(current is not None and stable_metadata(current) == stable_metadata(item), "prior_metadata_unchanged", rid)
        old_relative = ".trash/" + rid + ".md" if item.get("deleted") else "vault/" + item["path"]
        audit.same_file(inside(backup, old_relative), inside(home, old_relative), "prior_note", rid)
        (expected_trash_paths if item.get("deleted") else expected_active_paths).add(old_relative)
    actual_active = {"vault/" + path.relative_to(home / "vault").as_posix() for path in files(home / "vault", exclude_assets=True)
                     if path.suffix.lower() == ".md" and not any(part.startswith(".") for part in path.relative_to(home / "vault").parts)}
    actual_trash = {path.relative_to(home).as_posix() for path in files(home / ".trash") if path.suffix.lower() == ".md"}
    audit.check(actual_active == expected_active_paths, "active_markdown_inventory", detail=f"extra={len(actual_active-expected_active_paths)}, missing={len(expected_active_paths-actual_active)}")
    audit.check(actual_trash == expected_trash_paths, "trash_markdown_inventory")
    audit.check(len(metadata) == len(rows) + len(prior_notes), "no_extra_note_records")
    for legacy_id in legacy_source_ids:
        matches = by_source.get(legacy_id, [])
        audit.check(legacy_id in source_ids and any(item.get("sourceId") == legacy_id for item in previous)
                    and len(matches) == 1 and matches[0]["id"] == legacy_id,
                    "legacy_single_source_id", legacy_id)
    baseline_files = baseline["files"]
    audit.check(baseline.get("count") == len(baseline_files) == expected.get("baseline", len(baseline_files)), "baseline_count")
    audit.check(Path(baseline["sourceRoot"]).resolve() == source, "baseline_source_root")
    baseline_paths = {item["path"] for item in baseline_files}
    audit.check(len(baseline_paths) == len(baseline_files), "baseline_unique_paths")
    audit.check(set(source_paths).issubset(baseline_paths), "baseline_covers_all_documents")
    actual_readable = {path.relative_to(source).as_posix() for path in files(inside(source, "可阅读导出"))}
    audit.check(actual_readable == {path for path in baseline_paths if path.startswith("可阅读导出/")}, "source_readable_inventory_unchanged")
    for item in baseline_files:
        relative = item["path"]
        if relative.startswith("原始备份/") or not (relative.startswith("可阅读导出/") or relative in {"导出报告.txt", "导出清单.json", "异常清单.json", "元数据/文件夹.json", "导出清单.csv"}):
            audit.check(False, "baseline_read_scope", detail="baseline 包含不允许读取的区域"); continue
        file = inside(source, relative)
        audit.check(file.is_file() and file.stat().st_size == item["size"] and digest(file) == item["sha256"], "source_baseline_unchanged", relative)
    audit.metrics["uniqueExternalLinkUrls"] = len(external_urls)
    if "anomalies" in expected:
        anomalies = read_json(inside(source, "异常清单.json"))
        audit.metrics["sourceExportAnomalies"] = len(anomalies)
        audit.check(len(anomalies) == expected["anomalies"], "source_anomaly_count")
    audit.metrics.update({"sourceAssets": len(asset_files), "sourceHtml": len(rows),
                          "originalMarkdownCopies": len(rows), "sourceBaselineFiles": len(baseline_files),
                          "activeMarkdown": len(actual_active), "trashMarkdown": len(actual_trash),
                          "preservedPriorNotes": len(prior_notes)})
    report = audit.report()
    report["limitations"] = ["外部 URL 数量为静态 token 统计，不等于浏览器渲染后的有效链接数；没有联网验证外部地址。",
                             "原导出已经无法映射的本地引用单列 warning，原字符串完整保留，未声称已修复。"]
    if import_report is not None:
        imported = Counter((record["id"], ref["url"]) for record in read_json(Path(import_report))["records"]
                           for ref in record["references"] if ref["kind"] == "external")
        added, removed = external_occurrences - imported, imported - external_occurrences
        explanations = []
        for key, amount in list(removed.items()):
            full = (key[0], key[1] + ")")
            paired = min(amount, added.get(full, 0))
            if paired:
                explanations.append({**external_locations[full], "category": "importer_truncates_closing_parenthesis_in_url_token", "occurrences": paired})
                removed[key] -= paired; added[full] -= paired
        for key, amount in added.items():
            if amount:
                location = external_locations[key]
                explanations.append({**location, "category": "additional_token_in_nested_markdown" if location["nestedMarkdownLikeSyntax"] else "additional_independent_url_token", "occurrences": amount})
        report["parserComparison"] = {"diagnosticOnly": True, "importerExternalOccurrences": sum(imported.values()),
            "independentExternalOccurrences": sum(external_occurrences.values()), "explainedDifferences": explanations,
            "remainingImporterOnlyOccurrences": sum(removed.values()),
            "integrityBasis": "每个独立识别的外部 URL 源/目的逐字一致，且整篇正文除允许的链接目标以外一致。"}
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--vault-home", type=Path, required=True)
    parser.add_argument("--backup-home", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--archive-name", default="youdao-export")
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--import-report", type=Path, help="可选，仅解释两种解析统计差异；不作为完整性结论依据")
    parser.add_argument("--expected-counts", type=Path, help="可选JSON对象，提供独立已知数量；默认按清单、原备份和基线逐文件核对")
    parser.add_argument("--replaced-legacy-source", action="append", default=None,
                        help="导入时显式替换的旧来源sourceId，可重复；默认要求保留所有原有笔记")
    args = parser.parse_args(argv)
    report_path = assert_plain(args.report).resolve()
    for root in (args.source, args.vault_home, args.backup_home):
        if report_path.is_relative_to(root.resolve()):
            parser.error("报告必须写在所有输入目录之外，例如 /tmp")
    for input_file in (args.baseline, args.expected_counts, args.import_report):
        if input_file is not None and report_path == input_file.resolve():
            parser.error("报告不得覆盖输入文件")
    try:
        expected = read_json(args.expected_counts) if args.expected_counts is not None else None
        report = verify(args.source, args.vault_home, args.backup_home, args.baseline, args.archive_name,
                        expected=expected, import_report=args.import_report,
                        legacy_source_ids=args.replaced_legacy_source)
    except (OSError, ValueError, KeyError, TypeError) as error:
        report = {"readOnly": True, "failed": 1, "fatalError": type(error).__name__, "message": str(error)}
    report_path.parent.mkdir(parents=True, exist_ok=True)
    with report_path.open("w", encoding="utf-8") as handle:
        os.chmod(report_path, 0o600)
        json.dump(report, handle, ensure_ascii=False, indent=2); handle.write("\n")
    print(json.dumps({"passed": report.get("passed", 0), "failed": report["failed"],
                      "metrics": report.get("metrics", {}), "warnings": report.get("warnings", {}), "report": str(report_path)}, ensure_ascii=False))
    return int(report["failed"] > 0)


if __name__ == "__main__":
    raise SystemExit(main())
