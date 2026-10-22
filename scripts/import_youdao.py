#!/usr/bin/env python3
"""Import locally downloaded, unlocked Youdao DOCX files into Neuron Vault.

Only Python's standard library is required. No original resources are downloaded.
Example: python3 scripts/import_youdao.py --manifest downloads.json --dry-run
         python3 scripts/import_youdao.py --manifest downloads.json --base-url http://127.0.0.1:8787
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import posixpath
import re
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree as ET

NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "v": "urn:schemas-microsoft-com:vml",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
W = "{" + NS["w"] + "}"
R = "{" + NS["r"] + "}"
MAX_ZIP_BYTES = 100 * 1024 * 1024
MAX_MEMBER_BYTES = 40 * 1024 * 1024
MAX_UNPACKED_BYTES = 256 * 1024 * 1024
MONO = re.compile(r"consolas|courier|monaco|menlo|mono|source code|等线代码", re.I)
CODE_STYLE = re.compile(r"code|preformatted|代码", re.I)


class ImportProblem(Exception):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_component(value: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}", value):
        return value
    return "source-" + digest(value.encode("utf-8"))[:24]


def validate_folder(value: str) -> str:
    value = (value or "").strip()
    path = PurePosixPath(value)
    if path.is_absolute() or "\\" in value or "\0" in value or any(p in ("..", ".") or p.startswith(".") for p in value.split("/") if p):
        raise ImportProblem("笔记目录不能包含绝对路径、隐藏目录或路径跳转")
    return "" if str(path) == "." else str(path)


def no_symlinks(path: Path) -> None:
    absolute = path.absolute()
    for candidate in [*reversed(absolute.parents), absolute]:
        if candidate.is_symlink():
            raise ImportProblem("目标目录或文件包含符号链接，已拒绝写入")


def write_private(path: Path, data: bytes, immutable: bool = False) -> None:
    no_symlinks(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    no_symlinks(path.parent)
    if path.exists() and immutable:
        if path.read_bytes() != data:
            raise ImportProblem("已有同名文件内容不同，已停止以避免覆盖")
        return
    fd, tmp = tempfile.mkstemp(prefix=".youdao-import-", dir=path.parent)
    try:
        os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        no_symlinks(path)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def xml(data: bytes) -> ET.Element:
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ImportProblem("DOCX XML 包含不允许的实体声明")
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise ImportProblem("DOCX XML 损坏") from exc


def plain_text(element: ET.Element) -> str:
    pieces = []
    for node in element.iter():
        if node.tag == W + "t":
            pieces.append(node.text or "")
        elif node.tag == W + "tab":
            pieces.append("\t")
        elif node.tag in (W + "br", W + "cr"):
            pieces.append("\n")
    return "".join(pieces)


def escape_text(text: str) -> str:
    return re.sub(r"([\\`*_\[\]<>])", r"\\\1", text)


def inline_code(text: str) -> str:
    longest = max((len(m.group()) for m in re.finditer(r"`+", text)), default=0)
    fence = "`" * (longest + 1)
    pad = " " if text.startswith("`") or text.endswith("`") else ""
    return fence + pad + text + pad + fence


def link(label: str, target: str, image: bool = False) -> str:
    if re.match(r"^(?:javascript|data|vbscript|file):", target, re.I):
        return label + "（" + escape_text(target) + "）"
    safe = urllib.parse.quote(target, safe=":/?#[]@!$&'()*+,;=%-._~")
    return ("!" if image else "") + "[" + label.replace("]", r"\]") + "](<" + safe + ">)"


@dataclass
class Conversion:
    markdown: str
    assets: dict[str, bytes]
    text_characters: int
    image_count: int
    image_references: int
    warnings: list[str] = field(default_factory=list)


class DocxConverter:
    """Read visible OOXML content without changing or executing the source file."""
    def __init__(self, path: Path, source_id: str, folder: str):
        self.path = path
        self.source_id = safe_component(source_id)
        self.folder = validate_folder(folder)
        self.assets: dict[str, bytes] = {}
        self.asset_by_member: dict[str, str] = {}
        self.warnings: list[str] = []
        self.image_references = 0
        self.image_members: set[str] = set()
        self.footnotes: set[str] = set()
        self.relationships: dict[str, tuple[str, str]] = {}
        self.styles: dict[str, dict] = {}
        self.numbers: dict[str, dict] = {}
        self.number_counts: dict[tuple[str, int], int] = {}
        self.z: zipfile.ZipFile | None = None
        self.source_bytes = b""

    def warn(self, text: str) -> None:
        if text not in self.warnings:
            self.warnings.append(text)

    def read_xml(self, member: str) -> ET.Element | None:
        if member not in self.z.namelist():
            return None
        return xml(self.z.read(member))

    def load_relationships(self) -> None:
        root = self.read_xml("word/_rels/document.xml.rels")
        if root is None:
            return
        for rel in root:
            self.relationships[rel.get("Id", "")] = (rel.get("Target", ""), rel.get("TargetMode", "Internal"))

    def load_styles(self) -> None:
        root = self.read_xml("word/styles.xml")
        if root is None:
            return
        for style in root.findall("w:style", NS):
            sid = style.get(W + "styleId", "")
            name = style.find("w:name", NS)
            based = style.find("w:basedOn", NS)
            outline = style.find("w:pPr/w:outlineLvl", NS)
            fonts = style.find("w:rPr/w:rFonts", NS)
            self.styles[sid] = {"name": name.get(W + "val", sid) if name is not None else sid,
                                "based": based.get(W + "val", "") if based is not None else "",
                                "outline": outline.get(W + "val") if outline is not None else None,
                                "mono": fonts is not None and any(MONO.search(v) for v in fonts.attrib.values())}

    def style_info(self, sid: str) -> dict:
        result = {"name": sid, "mono": False, "outline": None}
        seen = set()
        while sid and sid not in seen:
            seen.add(sid)
            item = self.styles.get(sid, {})
            result["mono"] |= bool(item.get("mono")) or bool(CODE_STYLE.search(item.get("name", sid)))
            result["outline"] = result["outline"] if result["outline"] is not None else item.get("outline")
            if result["name"] == sid:
                result["name"] = item.get("name", sid)
            sid = item.get("based", "")
        return result

    def load_numbering(self) -> None:
        root = self.read_xml("word/numbering.xml")
        if root is None:
            return
        abstract = {}
        for node in root.findall("w:abstractNum", NS):
            levels = {}
            for level in node.findall("w:lvl", NS):
                fmt = level.find("w:numFmt", NS)
                start = level.find("w:start", NS)
                levels[int(level.get(W + "ilvl", "0"))] = {"format": fmt.get(W + "val", "bullet") if fmt is not None else "bullet",
                                                           "start": int(start.get(W + "val", "1")) if start is not None else 1}
            abstract[node.get(W + "abstractNumId", "")] = levels
        for node in root.findall("w:num", NS):
            aid = node.find("w:abstractNumId", NS)
            if aid is not None:
                self.numbers[node.get(W + "numId", "")] = abstract.get(aid.get(W + "val", ""), {})

    def asset(self, rid: str, alt: str = "图片") -> str:
        target, mode = self.relationships.get(rid, ("", ""))
        if not target:
            self.warn("部分图片缺少关系映射，原始 DOCX 中仍保留原件")
            return "[图片关系缺失]"
        if mode.lower() == "external":
            self.warn("存在外链图片，仅保留链接，未下载网络资源")
            return link("外部图片：" + alt, target)
        member = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join("word", target))
        if not member.startswith("word/media/") or member not in self.z.namelist():
            self.warn("部分图片没有嵌入 DOCX，保留原件供核对")
            return "[未嵌入的图片：" + escape_text(alt) + "]"
        if member not in self.asset_by_member:
            blob = self.z.read(member)
            basename = re.sub(r"[^A-Za-z0-9._-]", "-", PurePosixPath(member).name)
            basename = (basename[:100] or "image.bin")
            rel = f"assets/youdao/{self.source_id}/{digest(blob)[:16]}-{basename}"
            self.assets[rel] = blob
            self.asset_by_member[member] = rel
        self.image_members.add(member)
        self.image_references += 1
        relative = posixpath.relpath(self.asset_by_member[member], self.folder or ".")
        return link(escape_text(alt or "图片"), relative, image=True)

    def is_mono_run(self, run: ET.Element) -> bool:
        fonts = run.find("w:rPr/w:rFonts", NS)
        if fonts is not None and any(MONO.search(v) for v in fonts.attrib.values()):
            return True
        style = run.find("w:rPr/w:rStyle", NS)
        return style is not None and self.style_info(style.get(W + "val", ""))["mono"]

    def enabled(self, props: ET.Element | None, tag: str) -> bool:
        node = props.find("w:" + tag, NS) if props is not None else None
        return node is not None and node.get(W + "val", "true").lower() not in ("0", "false", "off")

    def inline(self, node: ET.Element, raw: bool = False) -> str:
        if node.tag in (W + "pPr", W + "rPr", W + "instrText", W + "del", W + "proofErr"):
            return ""
        if node.tag == W + "t":
            return (node.text or "") if raw else escape_text(node.text or "")
        if node.tag == W + "tab":
            return "\t"
        if node.tag in (W + "br", W + "cr"):
            return "\n" if raw else "  \n"
        if node.tag == W + "footnoteReference":
            fid = node.get(W + "id", "")
            self.footnotes.add(fid)
            return f"[^fn{fid}]"
        if node.tag == W + "drawing":
            images = node.findall(".//a:blip", NS)
            prop = node.find(".//wp:docPr", NS)
            alt = (prop.get("descr") or prop.get("title") or "图片") if prop is not None else "图片"
            return "\n".join(self.asset(img.get(R + "embed") or img.get(R + "link", ""), alt) for img in images)
        if node.tag == W + "pict":
            return "\n".join(self.asset(img.get(R + "id", ""), img.get("title", "图片")) for img in node.findall(".//v:imagedata", NS))
        if node.tag == W + "fldSimple":
            label = "".join(self.inline(child, raw) for child in node)
            match = re.search(r'HYPERLINK\s+"([^"]+)"', node.get(W + "instr", ""), re.I)
            return link(label, match.group(1)) if match and not raw else label
        if node.tag == W + "hyperlink":
            label = "".join(self.inline(child, raw) for child in node)
            if raw:
                return label
            rid = node.get(R + "id", "")
            target = self.relationships.get(rid, ("", ""))[0]
            anchor = node.get(W + "anchor")
            if anchor:
                target = "#" + anchor
            return link(label, target) if target else label
        if node.tag == W + "r":
            text = "".join(self.inline(child, raw) for child in node)
            if raw or not text or "![" in text:
                return text
            props = node.find("w:rPr", NS)
            if self.is_mono_run(node) and "\n" not in text:
                return inline_code(plain_text(node))
            if self.enabled(props, "b"):
                text = "**" + text + "**"
            if self.enabled(props, "i"):
                text = "*" + text + "*"
            if self.enabled(props, "strike"):
                text = "~~" + text + "~~"
            return text
        if node.tag == W + "object":
            self.warn("存在嵌入对象，Markdown 仅保留其可见文本；完整对象保存在原始 DOCX")
        return "".join(self.inline(child, raw) for child in node)

    def paragraph(self, p: ET.Element) -> tuple[str, bool]:
        pstyle = p.find("w:pPr/w:pStyle", NS)
        info = self.style_info(pstyle.get(W + "val", "")) if pstyle is not None else {"name": "", "mono": False, "outline": None}
        runs = p.findall(".//w:r", NS)
        text_runs = [r for r in runs if plain_text(r)]
        mono = info["mono"] or bool(text_runs and all(self.is_mono_run(r) for r in text_runs))
        # Do not mistake a styled image paragraph for a code block.
        mono = mono and p.find(".//w:drawing", NS) is None and p.find(".//w:pict", NS) is None
        text = self.inline(p, raw=mono)
        if mono:
            return text, True
        outline = p.find("w:pPr/w:outlineLvl", NS)
        level = outline.get(W + "val") if outline is not None else info["outline"]
        heading = re.search(r"(?:heading|标题)\s*([1-6])", info["name"], re.I)
        if level is not None and level.isdigit() and int(level) < 6:
            text = "#" * (int(level) + 1) + " " + text
        elif heading:
            text = "#" * int(heading.group(1)) + " " + text
        elif info["name"].lower() == "title":
            text = "# " + text
        num = p.find("w:pPr/w:numPr/w:numId", NS)
        if num is not None:
            nid = num.get(W + "val", "")
            level_node = p.find("w:pPr/w:numPr/w:ilvl", NS)
            depth = int(level_node.get(W + "val", "0")) if level_node is not None else 0
            spec = self.numbers.get(nid, {}).get(depth, {"format": "bullet", "start": 1})
            if spec["format"] == "bullet":
                prefix = "- "
            else:
                key = (nid, depth)
                self.number_counts[key] = self.number_counts.get(key, spec["start"] - 1) + 1
                prefix = str(self.number_counts[key]) + ". "
            text = "  " * depth + prefix + text.replace("\n", "\n" + "  " * (depth + 1))
        return text, False

    def table(self, table: ET.Element) -> str:
        rows = []
        for row in table.findall("w:tr", NS):
            cells = []
            for cell in row.findall("w:tc", NS):
                blocks = self.blocks(list(cell))
                value = blocks.strip().replace("|", r"\|").replace("\n", "<br>")
                cells.append(value)
                span = cell.find("w:tcPr/w:gridSpan", NS)
                if span is not None:
                    count = int(span.get(W + "val", "1"))
                    cells.extend([""] * max(0, count - 1))
                    self.warn("合并单元格已展平为 Markdown 表格；精确版式保存在原始 DOCX")
                if cell.find("w:tcPr/w:vMerge", NS) is not None:
                    self.warn("合并单元格已展平为 Markdown 表格；精确版式保存在原始 DOCX")
            rows.append(cells)
        if not rows:
            return ""
        width = max(map(len, rows))
        rows = [r + [""] * (width - len(r)) for r in rows]
        render = lambda row: "| " + " | ".join(row) + " |"
        return "\n".join([render(rows[0]), render(["---"] * width), *(render(r) for r in rows[1:])])

    def blocks(self, nodes: list[ET.Element]) -> str:
        result, code = [], []
        def flush_code():
            if code:
                value = "\n".join(code)
                size = max(3, max((len(m.group()) + 1 for m in re.finditer(r"`+", value)), default=3))
                fence = "`" * size
                result.append(fence + "\n" + value + "\n" + fence)
                code.clear()
        for node in nodes:
            if node.tag == W + "p":
                value, is_code = self.paragraph(node)
                if is_code:
                    code.append(value)
                else:
                    flush_code()
                    result.append(value)
            elif node.tag == W + "tbl":
                flush_code()
                result.append(self.table(node))
            elif node.tag in (W + "sdt", W + "sdtContent", W + "ins"):
                flush_code()
                result.append(self.blocks(list(node)))
            elif node.tag == W + "altChunk":
                self.warn("存在 DOCX 替代格式内容，未自动执行或载入；请核对原始 DOCX")
        flush_code()
        return "\n\n".join(result)

    def convert(self) -> Conversion:
        if not self.path.is_file() or self.path.stat().st_size > MAX_ZIP_BYTES:
            raise ImportProblem("本地 DOCX 不存在或文件过大")
        try:
            self.source_bytes = self.path.read_bytes()
            with zipfile.ZipFile(io.BytesIO(self.source_bytes)) as archive:
                self.z = archive
                members = archive.infolist()
                if len(members) > 10000 or sum(m.file_size for m in members) > MAX_UNPACKED_BYTES or any(m.file_size > MAX_MEMBER_BYTES for m in members):
                    raise ImportProblem("DOCX 解压体积超出导入限制")
                if any(m.flag_bits & 1 for m in members):
                    raise ImportProblem("DOCX 已加密，按约定跳过")
                if len({m.filename for m in members}) != len(members):
                    raise ImportProblem("DOCX 包含重复压缩条目")
                for member in members:
                    p = PurePosixPath(member.filename)
                    if p.is_absolute() or ".." in p.parts or "\\" in member.filename:
                        raise ImportProblem("DOCX 包含不安全的压缩路径")
                settings = self.read_xml("word/settings.xml")
                if settings is not None:
                    protection = settings.find("w:documentProtection", NS)
                    if protection is not None and protection.get(W + "enforcement", "0") in ("1", "true", "on"):
                        raise ImportProblem("DOCX 设置了文档保护，按约定跳过")
                doc = self.read_xml("word/document.xml")
                if doc is None:
                    raise ImportProblem("文件缺少 Word 正文")
                body = doc.find("w:body", NS)
                if body is None:
                    raise ImportProblem("文件缺少 Word 正文容器")
                self.load_relationships()
                self.load_styles()
                self.load_numbering()
                text = self.blocks(list(body))
                footnotes = self.read_xml("word/footnotes.xml")
                if footnotes is not None:
                    for footnote in footnotes.findall("w:footnote", NS):
                        fid = footnote.get(W + "id", "")
                        if fid in self.footnotes:
                            content = self.blocks(list(footnote)).strip().replace("\n", "\n    ")
                            text += f"\n\n[^fn{fid}]: {content}"
                # Keep every packaged image, including image resources not referenced by document.xml.
                for member in members:
                    if member.filename.startswith("word/media/") and not member.is_dir() and member.filename not in self.asset_by_member:
                        blob = archive.read(member)
                        basename = re.sub(r"[^A-Za-z0-9._-]", "-", PurePosixPath(member.filename).name)[:100]
                        self.assets[f"assets/youdao/{self.source_id}/{digest(blob)[:16]}-{basename}"] = blob
                if any(m.filename.startswith("word/media/") and not m.is_dir() and m.filename not in self.image_members for m in members):
                    self.warn("部分包内图片未在正文中引用，已保留到附件目录供核对")
                raw_visible = plain_text(body)
                return Conversion(text.rstrip("\n") + "\n", self.assets, len(raw_visible),
                                  len([m for m in members if m.filename.startswith("word/media/") and not m.is_dir()]),
                                  self.image_references, self.warnings)
        except (zipfile.BadZipFile, RuntimeError, OSError) as exc:
            raise ImportProblem("DOCX 无法读取，可能已加密、损坏或尚未下载完整") from exc


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise ImportProblem("本机 API 返回了重定向，已拒绝跟随")


class LocalApi:
    def __init__(self, base_url: str):
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1") or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ImportProblem("仅允许连接本机 HTTP API")
        self.base = base_url.rstrip("/")
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, headers={"Content-Type": "application/json"} if body is not None else {})
        try:
            with self.opener.open(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            raw = exc.read(2048).decode("utf-8", "replace")
            try:
                message = json.loads(raw).get("error", "请求失败")
            except ValueError:
                message = "请求失败"
            raise ImportProblem(f"本机 API 返回 HTTP {exc.code}: {message}") from exc
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            raise ImportProblem("无法访问本机 API 或响应格式无效") from exc


def run(manifest: list[dict], api: LocalApi | None, data_root: Path | None, dry_run: bool, report_path: Path | None) -> dict:
    report = {"startedAt": datetime.now(timezone.utc).isoformat(), "dryRun": dry_run, "notes": []}
    if not isinstance(manifest, list):
        raise ImportProblem("下载清单必须是 JSON 数组")
    if not dry_run:
        settings = api.request("/api/settings")
        actual_vault = Path(settings["vaultPath"]).absolute()
        if not actual_vault.is_absolute() or actual_vault.name != "vault":
            raise ImportProblem("后端返回了意外的知识库路径")
        no_symlinks(actual_vault)
        actual_data = actual_vault.parent
        if data_root is not None and data_root.absolute() != actual_data:
            raise ImportProblem("指定 data-root 与运行后端的数据目录不一致，已停止导入")
        data_root = actual_data
        if report_path is None:
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
            report_path = data_root / "import-manifests" / f"youdao-{stamp}.json"
    def save():
        if report_path is not None:
            write_private(report_path, json.dumps(report, ensure_ascii=False, indent=2).encode("utf-8"))
    for row in manifest:
        if not isinstance(row, dict):
            report["notes"].append({"status": "skipped", "reason": "下载清单条目不是对象"})
            save()
            continue
        entry = {key: row.get(key) for key in ("title", "folder", "sourceUrl", "sourceId", "downloadPath")}
        entry["status"] = "pending"
        report["notes"].append(entry)
        try:
            state = str(row.get("status", "")).lower()
            if row.get("locked") or row.get("encrypted") or state in ("locked", "encrypted", "failed", "export_failed", "skipped", "skip"):
                entry.update(status="skipped", reason="加锁、加密或导出失败的条目，不读取内容")
                continue
            if not row.get("downloadPath"):
                entry.update(status="skipped", reason="没有可读取的本地下载文件")
                continue
            if not isinstance(row.get("title"), str) or not row["title"].strip():
                raise ImportProblem("下载条目缺少标题")
            source_id = str(row.get("sourceId") or row.get("sourceUrl") or "")
            if not source_id:
                raise ImportProblem("下载条目缺少稳定来源 ID 或 URL")
            folder = validate_folder(row.get("folder") or "")
            source = Path(row["downloadPath"]).expanduser()
            if source.suffix.lower() != ".docx":
                raise ImportProblem("当前转换器只接受本地 .docx 文件")
            converter = DocxConverter(source, source_id, folder)
            converted = converter.convert()
            source_bytes = converter.source_bytes
            source_hash = digest(source_bytes)
            entry.update(sourceSha256=source_hash, textCharacters=converted.text_characters, imageCount=converted.image_count,
                         imageReferences=converted.image_references, markdownSha256=digest(converted.markdown.encode("utf-8")),
                         warnings=converted.warnings, assets=list(converted.assets))
            if dry_run:
                entry["status"] = "ready"
                continue
            component = safe_component(source_id)
            original = data_root / "originals" / "youdao" / (component + ".docx")
            no_symlinks(original)
            if original.exists() and digest(original.read_bytes()) != source_hash:
                original = original.with_name(component + "-" + source_hash[:16] + ".docx")
            write_private(original, source_bytes, immutable=True)
            entry["originalPath"] = str(original)
            for relative, blob in converted.assets.items():
                write_private(data_root / "vault" / relative, blob, immutable=True)
            result = api.request("/api/import", {"notes": [{"title": row["title"], "folder": folder,
                                 "content": converted.markdown, "sourceUrl": row.get("sourceUrl"), "sourceId": source_id}]})
            entry.update(status="imported" if result.get("imported", 0) else "skipped_duplicate",
                         imported=result.get("imported", 0), skipped=result.get("skipped", 0),
                         noteIds=[n["id"] for n in result.get("notes", [])], notePaths=[n["path"] for n in result.get("notes", [])])
        except (ImportProblem, OSError, KeyError, TypeError, ValueError) as exc:
            entry.update(status="skipped" if isinstance(exc, ImportProblem) and ("加密" in str(exc) or "保护" in str(exc)) else "error", reason=str(exc))
        finally:
            save()
    report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    report["counts"] = {status: sum(n["status"] == status for n in report["notes"]) for status in ("ready", "imported", "skipped_duplicate", "skipped", "error")}
    if report_path is not None:
        report["reportPath"] = str(report_path.absolute())
    save()
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest", type=Path, required=True, help="已下载 DOCX 的 JSON 清单")
    parser.add_argument("--base-url", default="http://127.0.0.1:8787")
    parser.add_argument("--data-root", type=Path, help="可选；必须与后端实际数据根目录一致")
    parser.add_argument("--report", type=Path, help="迁移报告；正式导入默认放 data/import-manifests/")
    parser.add_argument("--dry-run", action="store_true", help="仅读取检查，不调用 API、不复制原件或图片；可保存指定报告")
    args = parser.parse_args(argv)
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        result = run(manifest, None if args.dry_run else LocalApi(args.base_url), args.data_root, args.dry_run, args.report)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if result["counts"]["error"] else 0
    except (ImportProblem, OSError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
