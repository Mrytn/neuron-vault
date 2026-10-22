"""Offline migration regression tests: temporary fixtures only, no real notes."""
from contextlib import contextmanager
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.parse

SPEC = importlib.util.spec_from_file_location("youdao_export", Path(__file__).with_name("import_youdao_export.py"))
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)
LEGACY_SOURCE_ID = "fixture-legacy-note"


@contextmanager
def local_file_lock(work, port):
    """File transaction tests do not need sockets; port rejection is tested separately."""
    work.mkdir(parents=True, exist_ok=True)
    yield


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="neuron-youdao-import-tests-")
        self.root = Path(self.temporary.name)
        self.source = self.root / "export"
        self.home = self.root / "data"
        self.work = self.root / "transactions"
        (self.home / "vault/计划").mkdir(parents=True)
        (self.home / "vault/计划/保留.md").write_text("# 保留\n用户原有计划。\n", encoding="utf-8")
        (self.home / ".metadata").mkdir()
        self.existing = {"id": "existing-plan", "path": "计划/保留.md", "title": "保留", "deleted": False}
        self.write_index([self.existing])
        for directory in ["可阅读导出/笔记/学习", "可阅读导出/笔记/空目录", "可阅读导出/回收站", "附件/图片", "元数据"]:
            (self.source / directory).mkdir(parents=True, exist_ok=True)
        (self.source / "附件/图片/a.png").write_bytes(b"\x89PNG\r\n\x1a\nfixture-image")
        # A deliberately unusable raw-backup link confirms it is never traversed.
        (self.source / "原始备份").symlink_to(self.root / "DO-NOT-READ", target_is_directory=True)
        self.rows = [
            self.record("noteA", "链接", content="# 链接\n\n![图片](../../../%E9%99%84%E4%BB%B6/%E5%9B%BE%E7%89%87/a.png)\n\n[另篇](目标__noteB.html#段落)\n\n`![代码](../../../附件/图片/a.png)`\n"),
            self.record("noteB", "目标", content="# 目标\n\n完整正文。\n"),
            self.record("missing", "正文缺失", status="missing_body", content="# 正文缺失\n\nCACHE-TEXT-MUST-NOT-BE-EVIDENCE\n"),
            self.record("encrypted", "已加密", status="encrypted", content="LOCKED-CONTENT-MUST-NOT-BE-IMPORTED"),
            self.record("trashA", "已删除", trashed=True, content="# 已删除\n\n可恢复。\n"),
        ]
        self.flush_manifest()

    def tearDown(self):
        self.temporary.cleanup()

    def write_index(self, records):
        (self.home / ".metadata/index.json").write_text(json.dumps(records, ensure_ascii=False), encoding="utf-8")

    def record(self, rid, title, status="ok", trashed=False, content=""):
        category = "回收站" if trashed else "笔记/学习"
        stem = f"可阅读导出/{category}/{title}__{rid}"
        for extension, body in [("md", content), ("html", "<!doctype html><html><body>原格式</body></html>")]:
            (self.source / (stem + "." + extension)).write_text(body, encoding="utf-8")
        return {"id": rid, "title": title + ".note", "status": status, "trashed": trashed,
                "markdown": stem + ".md", "html": stem + ".html", "source": "原始备份/DO-NOT-READ/" + rid,
                "createTime": 1700000000, "modifyTime": 1700000100, "encrypted": int(status == "encrypted"), "tags": ""}

    def flush_manifest(self):
        (self.source / "导出清单.json").write_text(json.dumps(self.rows, ensure_ascii=False), encoding="utf-8")
        (self.source / "导出清单.csv").write_text("id,title\nfixture,test\n", encoding="utf-8")
        (self.source / "导出报告.txt").write_text("fixture readable export; raw sources not used", encoding="utf-8")
        (self.source / "异常清单.json").write_text("[]", encoding="utf-8")
        (self.source / "元数据/文件夹.json").write_text('[{"fileId":"folder","title":"空目录"}]', encoding="utf-8")

    def plan(self, legacy=()):
        return mod.make_plan(mod.Source(self.source), self.home, "fixture-export", legacy)

    def apply(self, plan=None, **kwargs):
        with patch.object(mod, "offline_lock", local_file_lock):
            return mod.apply_plan(plan or self.plan(), self.work, **kwargs)

    def test_paths_placeholders_links_and_dry_run_are_read_only(self):
        before = {p.relative_to(self.home): p.read_bytes() for p in self.home.rglob("*") if p.is_file()}
        plan = self.plan()
        self.assertFalse(plan["report"]["conflicts"])
        by_id = {r["id"]: r for r in plan["records"]}
        content = by_id["noteA"]["_content"].decode()
        self.assertIn("../../../assets/youdao-export/", content)
        self.assertIn("%E7%9B%AE%E6%A0%87__noteB.md#段落", content)
        self.assertIn("`![代码](../../../附件/图片/a.png)`", content)
        self.assertNotIn("CACHE-TEXT", by_id["missing"]["_content"].decode())
        self.assertNotIn("LOCKED-CONTENT", by_id["encrypted"]["_content"].decode())
        self.assertIn("非完整正文", by_id["missing"]["_content"].decode())
        self.assertEqual(before, {p.relative_to(self.home): p.read_bytes() for p in self.home.rglob("*") if p.is_file()})

    def test_apply_preserves_existing_and_archives_html_with_trash(self):
        original_index = (self.home / ".metadata/index.json").read_bytes()
        result = self.apply()
        self.assertTrue(result["committed"])
        backup = Path(result["backupDirectory"])
        self.assertEqual((backup / ".metadata/index.json").read_bytes(), original_index)
        self.assertTrue((self.home / "vault/计划/保留.md").is_file())
        self.assertTrue((self.home / "vault/有道/笔记/空目录").is_dir())
        self.assertTrue((self.home / ".trash/trashA.md").is_file())
        self.assertFalse((self.home / "vault/有道/回收站/已删除__trashA.md").exists())
        metadata = {m["id"]: m for m in mod.load_json(self.home / ".metadata/index.json")}
        self.assertEqual(set(metadata), {r["id"] for r in self.rows} | {"existing-plan"})
        self.assertEqual(metadata["trashA"]["path"], "有道/回收站/已删除__trashA.md")
        self.assertEqual(metadata["noteA"]["sourceId"], "noteA")
        self.assertTrue(metadata["noteA"]["sourceModifiedAt"].endswith("Z"))
        html_path = self.home / "vault" / metadata["noteA"]["sourceHtmlPath"]
        self.assertEqual(html_path.read_bytes(), (self.source / self.rows[0]["html"]).read_bytes())
        copied = self.home / "vault/assets/youdao-export/附件/图片/a.png"
        self.assertEqual(copied.read_bytes(), (self.source / "附件/图片/a.png").read_bytes())

    def test_repeat_is_idempotent_and_user_edits_preserved(self):
        self.apply()
        note = self.home / "vault/有道/笔记/学习/链接__noteA.md"
        note.write_text("# 用户编辑\n保持我的修改\n", encoding="utf-8")
        plan = self.plan()
        actions = {r["id"]: r["action"] for r in plan["records"]}
        self.assertEqual(actions["noteA"], "skip_user_edited")
        self.assertTrue(all(v.startswith("skip_") for v in actions.values()))
        self.apply(plan)
        self.assertEqual(note.read_text(), "# 用户编辑\n保持我的修改\n")
        self.assertEqual(len(mod.load_json(self.home / ".metadata/index.json")), 6)

    def test_changed_source_conflicts_without_overwrite(self):
        self.apply()
        original = (self.home / "vault/有道/笔记/学习/目标__noteB.md").read_bytes()
        (self.source / self.rows[1]["markdown"]).write_text("# changed source", encoding="utf-8")
        plan = self.plan()
        self.assertTrue(any(x.get("id") == "noteB" for x in plan["report"]["conflicts"]))
        with self.assertRaises(mod.ImportFailure):
            self.apply(plan)
        self.assertEqual((self.home / "vault/有道/笔记/学习/目标__noteB.md").read_bytes(), original)

    def test_rollback_after_original_rename_restores_every_file(self):
        before = {p.relative_to(self.home): p.read_bytes() for p in self.home.rglob("*") if p.is_file()}
        with self.assertRaisesRegex(OSError, "injected rollback"):
            self.apply(fail_after_backup=True)
        self.assertEqual(before, {p.relative_to(self.home): p.read_bytes() for p in self.home.rglob("*") if p.is_file()})
        journals = list(self.work.glob("*/journal.json"))
        self.assertEqual(mod.load_json(journals[0])["phase"], "rolled_back")

    def test_legacy_sample_requires_matching_original_hash(self):
        old = self.home / "vault/有道/测试/legacy-sample.md"
        old.parent.mkdir(parents=True); old.write_text("original sample", encoding="utf-8")
        existing = {"id": "legacy-uuid", "sourceId": LEGACY_SOURCE_ID,
                    "path": "有道/测试/legacy-sample.md", "title": "legacy-sample", "deleted": False}
        self.write_index([self.existing, existing])
        (self.home / "imports").mkdir()
        (self.home / "imports/youdao-report.json").write_text(json.dumps({"notes": [
            {"sourceId": LEGACY_SOURCE_ID, "title": "legacy-sample", "notePaths": ["有道/测试/legacy-sample.md"],
             "markdownSha256": mod.file_hash(old)}]}), encoding="utf-8")
        self.rows.append(self.record(LEGACY_SOURCE_ID, "legacy-sample", content="# New complete export"))
        self.flush_manifest()
        self.assertTrue(any(r.get("id") == LEGACY_SOURCE_ID for r in self.plan()["report"]["conflicts"]),
                        "Legacy replacement must require an explicit source ID")
        allowed = self.plan([LEGACY_SOURCE_ID])
        record = next(r for r in allowed["records"] if r["id"] == LEGACY_SOURCE_ID)
        self.assertEqual(record["action"], "replace_verified_legacy")
        old.write_text("user changed sample", encoding="utf-8")
        refused = self.plan([LEGACY_SOURCE_ID])
        self.assertTrue(any(r.get("id") == LEGACY_SOURCE_ID for r in refused["report"]["conflicts"]))
        self.assertEqual(old.read_text(), "user changed sample")

    def test_duplicate_missing_and_traversal_are_rejected(self):
        self.rows.append(dict(self.rows[0])); self.flush_manifest()
        with self.assertRaisesRegex(mod.ImportFailure, "重复笔记ID"):
            self.plan()
        self.rows.pop(); self.flush_manifest()
        (self.source / self.rows[0]["html"]).unlink()
        with self.assertRaisesRegex(mod.ImportFailure, "缺少文件"):
            self.plan()
        with self.assertRaises(mod.ImportFailure):
            mod.beneath(self.source, "../escape")

    def test_symlink_attachment_is_rejected(self):
        (self.source / "附件/escape").symlink_to(self.home / "vault/计划/保留.md")
        with self.assertRaisesRegex(mod.ImportFailure, "符号链接"):
            self.plan()

    def test_vault_changed_after_plan_is_rejected(self):
        plan = self.plan()
        (self.home / "vault/计划/保留.md").write_text("changed while planning", encoding="utf-8")
        with self.assertRaisesRegex(mod.ImportFailure, "预检后发生变化"):
            self.apply(plan)

    def test_external_edit_during_staging_aborts_before_swap(self):
        plan = self.plan()
        original_copy = mod.verified_copy
        edited = False
        existing_note = self.home / "vault/计划/保留.md"
        def copy_then_edit(*args):
            nonlocal edited
            original_copy(*args)
            if not edited:
                existing_note.write_text("edited during staging", encoding="utf-8")
                edited = True
        with patch.object(mod, "verified_copy", copy_then_edit):
            with self.assertRaisesRegex(mod.ImportFailure, "暂存期间"):
                self.apply(plan)
        self.assertEqual(existing_note.read_text(), "edited during staging")
        self.assertFalse((self.home / "vault/有道").exists())

    def test_query_and_code_examples_are_preserved(self):
        path = self.source / self.rows[0]["markdown"]
        code = ("    ![](../../../附件/图片/a.png)\n"
                "> ```md\n> ![](../../../附件/图片/a.png)\n> ```\n"
                "`` ` ![](../../../附件/图片/a.png) ``\n")
        path.write_text("[目标](目标__noteB.html?view=full#段落)\n" + code, encoding="utf-8")
        record = self.plan()["records"][0]
        rewritten = record["_content"].decode()
        self.assertIn("__noteB.md?view=full#段落", rewritten)
        self.assertTrue(rewritten.endswith(code))

    def test_source_id_cannot_overwrite_unrelated_app_id(self):
        unrelated = {"id": "noteA", "path": "计划/保留.md", "title": "保留", "deleted": False}
        self.write_index([unrelated])
        plan = self.plan()
        self.assertTrue(any(c.get("id") == "noteA" and "另一来源" in c["reason"] for c in plan["report"]["conflicts"]))
        self.assertEqual(plan["metadata"], [unrelated] + [r["_meta"] for r in plan["records"] if r["id"] != "noteA"])

    def test_occupied_backend_port_rejected(self):
        with patch.object(mod.socket, "socket") as socket_factory:
            socket_factory.return_value.__enter__.return_value.bind.side_effect = OSError("occupied")
            with self.assertRaisesRegex(mod.ImportFailure, "请停止后端"):
                with mod.offline_lock(self.work, 8787):
                    self.fail("must not acquire a running backend's port")


if __name__ == "__main__":
    unittest.main()
