"""Independent verifier tests; fixture files only, no production reads."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("verify_export", Path(__file__).with_name("verify_youdao_export.py"))
verify = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(verify)
COMPLETE_SOURCE_ID = "fixture-complete-note"


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(value, bytes): path.write_bytes(value)
    elif isinstance(value, (list, dict)): path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    else: path.write_text(value, encoding="utf-8")


class VerifyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="neuron-independent-audit-")
        self.root = Path(self.temp.name)
        self.source, self.home, self.backup = [self.root / name for name in ("source", "home", "backup")]
        self.baseline = self.root / "baseline.json"
        self.rows = []
        for rid, title, status, deleted in [(COMPLETE_SOURCE_ID, "完整", "ok", False), ("deleted", "回收", "ok", True), ("missing", "缺失", "missing_body", False)]:
            category = "回收站" if deleted else "笔记"
            stem = f"可阅读导出/{category}/folder/{rid}"
            self.rows.append({"id": rid, "title": title + ".note", "status": status, "trashed": deleted, "markdown": stem + ".md", "html": stem + ".html"})
        original = "# 完整\n\n![图片](../../../附件/a.png?size=2#view)\n[回收](../../回收站/folder/deleted.html#标题)\n[外部](https://example.test/unchanged?q=1)\n\n```md\n![示例](../../../附件/a.png)\n```\n"
        imported = original.replace("![图片](../../../附件/a.png?size=2#view)", "![图片](../../../assets/youdao-export/附件/a.png?size=2#view)").replace("deleted.html#标题", "deleted.md#标题")
        bodies = {COMPLETE_SOURCE_ID: original, "deleted": "# 回收\n\n![图片](../../../附件/a.png)\n", "missing": "CACHE-NOT-IMPORTED"}
        metadata = []
        for row in self.rows:
            rid = row["id"]
            write(self.source / row["markdown"], bodies[rid]); write(self.source / row["html"], "<html>original</html>")
            write(self.home / "imports/audit" / row["markdown"], bodies[rid])
            write(self.home / "vault/assets/youdao-export" / row["html"], "<html>original</html>")
            path = row["markdown"].replace("可阅读导出/", "有道/", 1)
            if rid == COMPLETE_SOURCE_ID: body = imported
            elif rid == "deleted": body = bodies[rid].replace("../../../附件/", "../../../assets/youdao-export/附件/")
            else:
                body = ("# 缺失\n\n> 来源状态：missing_body（非完整正文）\n\n"
                        "此笔记的原始正文缺失。本知识库仅保留占位信息，导出中的搜索缓存未被当作完整正文导入。\n\n"
                        "此记录不参与 AI 回答取证。请回到有道核对来源后重新导出。\n\n"
                        f"- 有道笔记 ID：`{rid}`\n- 可阅读导出路径：`{row['markdown']}`\n")
            physical = self.home / (f".trash/{rid}.md" if row["trashed"] else "vault/" + path)
            write(physical, body)
            metadata.append({"id": rid, "sourceId": rid, "sourceStatus": row["status"], "sourceExportPath": row["markdown"],
                             "sourceHtmlPath": "assets/youdao-export/" + row["html"], "path": path, "deleted": row["trashed"],
                             "lastHash": hashlib.sha256(body.encode()).hexdigest()})
        prior = {"id": "plan", "path": "计划.md", "title": "计划", "deleted": False}
        write(self.backup / ".metadata/index.json", [prior]); write(self.backup / "vault/计划.md", "keep unchanged")
        write(self.home / "vault/计划.md", "keep unchanged"); write(self.home / ".metadata/index.json", metadata + [prior])
        write(self.source / "附件/a.png", b"image bytes"); write(self.home / "vault/assets/youdao-export/附件/a.png", b"image bytes")
        write(self.source / "导出清单.json", self.rows)
        readable = [path for path in self.source.rglob("*") if path.is_file() and path.parent.name != "附件"]
        write(self.baseline, {"sourceRoot": str(self.source), "count": len(readable), "files": [
            {"path": path.relative_to(self.source).as_posix(), "size": path.stat().st_size, "sha256": verify.digest(path)} for path in readable]})
        self.expected = {"records": 3, "active": 2, "trash": 1, "assets": 1, "baseline": 7, "preserved": 1, "external": 1,
                         "status_counts": {"ok:active": 1, "ok:trash": 1, "missing_body:active": 1}}
    def tearDown(self): self.temp.cleanup()
    def audit(self): return verify.verify(self.source, self.home, self.backup, self.baseline, "audit", self.expected)
    def test_complete_audit_is_read_only_and_trash_links_are_not_broken_assets(self):
        before = {str(path): verify.digest(path) for path in self.root.rglob("*") if path.is_file()}
        result = self.audit()
        self.assertEqual(result["failed"], 0, result["failures"])
        self.assertEqual(result["metrics"]["linksToTrash"], 1)
        self.assertEqual(result["metrics"]["assetLinks"], 2)
        self.assertEqual(result["metrics"]["externalLinksUnchanged"], 1)
        self.assertEqual(before, {str(path): verify.digest(path) for path in self.root.rglob("*") if path.is_file()})
    def test_detects_real_body_changes_even_when_index_hash_is_updated(self):
        path = self.home / "vault/有道/笔记/folder" / (COMPLETE_SOURCE_ID + ".md")
        write(path, path.read_text().replace("# 完整", "# 被改写"))
        metadata = verify.read_json(self.home / ".metadata/index.json")
        metadata[0]["lastHash"] = verify.digest(path); write(self.home / ".metadata/index.json", metadata)
        result = self.audit()
        self.assertGreater(result["checksFailed"].get("body_only_destinations_changed", 0), 0)
    def test_detects_asset_damage_original_change_and_duplicate_markdown(self):
        write(self.home / "vault/assets/youdao-export/附件/a.png", b"damaged")
        write(self.source / self.rows[0]["html"], "modified source")
        write(self.home / "vault/duplicate.md", "unexpected note")
        result = self.audit()
        for category in ("asset_sha256", "html_sha256", "source_baseline_unchanged", "active_markdown_inventory"):
            self.assertGreater(result["checksFailed"].get(category, 0), 0, category)
    def test_code_and_nested_parenthesis_destinations_are_parsed_conservatively(self):
        text = "    ![indented](a.png)\n\n> ````md\n> ![quoted](a.png)\n> ```\n> ````\n\n`` code ` ![inline](a.png) ``\n![real](a(b).png)\n[x]: <a(b).md>\n"
        self.assertEqual([text[a:b] for a,b in verify.url_spans(text)], ["a(b).png", "a(b).md"])
    def test_symlink_inputs_are_rejected(self):
        (self.source / "附件/escape.png").symlink_to(self.home / "vault/计划.md")
        with self.assertRaises(ValueError): self.audit()

    def test_default_counts_are_derived_from_inputs_not_a_specific_library(self):
        result = verify.verify(self.source, self.home, self.backup, self.baseline, "audit")
        self.assertEqual(result["failed"], 0, result["failures"])
        self.assertEqual(result["metrics"]["sourceRecords"], len(self.rows))

    def test_replaced_legacy_sources_require_explicit_ids(self):
        previous = verify.read_json(self.backup / ".metadata/index.json")
        previous.append({"id": "old-app-id", "sourceId": COMPLETE_SOURCE_ID,
                         "path": "old-note.md", "title": "Old sample", "deleted": False})
        write(self.backup / ".metadata/index.json", previous)
        write(self.backup / "vault/old-note.md", "old sample")
        refused = verify.verify(self.source, self.home, self.backup, self.baseline, "audit")
        self.assertGreater(refused["failed"], 0)
        approved = verify.verify(self.source, self.home, self.backup, self.baseline, "audit",
                                 legacy_source_ids=[COMPLETE_SOURCE_ID])
        self.assertEqual(approved["failed"], 0, approved["failures"])
        self.assertEqual(approved["checksPassed"]["legacy_single_source_id"], 1)

    def test_explicit_expected_counts_are_still_checked(self):
        result = verify.verify(self.source, self.home, self.backup, self.baseline, "audit", expected={"records": 99})
        self.assertEqual(result["checksFailed"].get("source_unique_count"), 1)


if __name__ == "__main__": unittest.main()
