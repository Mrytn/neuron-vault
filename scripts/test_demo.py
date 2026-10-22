#!/usr/bin/env python3
"""Safety and fixture integrity tests. All writes use temporary synthetic homes."""

import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("prepare_demo", ROOT / "scripts" / "prepare_demo.py")
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


class DemoSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="neuron-demo-test-")
        self.root = Path(self.temp.name) / "checkout"
        (self.root / "scripts").mkdir(parents=True)
        shutil.copytree(ROOT / "demo", self.root / "demo")
        for name in ("demo.sh", "prepare_demo.py"):
            shutil.copy2(ROOT / "scripts" / name, self.root / "scripts" / name)

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, *args, extra_env=None):
        env = {k: v for k, v in os.environ.items() if k not in ("VAULT_HOME", "NEURON_DEMO_PORT", "NEURON_PORT")}
        env.update(extra_env or {})
        return subprocess.run(["bash", str(self.root / "scripts" / "demo.sh"), *args], cwd=self.root,
                              env=env, text=True, capture_output=True)

    def test_fresh_copy_has_only_synthetic_vault_and_marker(self):
        home = PREPARE.prepare(self.root)
        self.assertEqual(len(list((home / "vault").rglob("*.md"))), 48)
        self.assertEqual(sorted(p.name for p in home.iterdir()), [PREPARE.MARKER, "vault"])
        self.assertEqual(json.loads((home / PREPARE.MARKER).read_text()), PREPARE.IDENTITY)
        self.assertFalse((self.root / "data").exists())

    def test_existing_unmarked_data_is_never_overwritten(self):
        home = self.root / ".demo-data"
        home.mkdir()
        sentinel = home / "keep.txt"
        sentinel.write_text("do not replace")
        for reuse in (False, True):
            with self.assertRaises(ValueError): PREPARE.prepare(self.root, reuse)
        self.assertEqual(sentinel.read_text(), "do not replace")
        self.assertEqual(list(home.iterdir()), [sentinel])

    def test_reuse_preserves_edits_without_recopied_seed(self):
        home = PREPARE.prepare(self.root)
        note = next((home / "vault").rglob("*.md"))
        note.write_text("synthetic practice edit")
        with self.assertRaises(ValueError): PREPARE.prepare(self.root)
        self.assertEqual(PREPARE.prepare(self.root, True), home)
        self.assertEqual(note.read_text(), "synthetic practice edit")

    def test_destination_symlink_and_mismatched_marker_are_rejected(self):
        outside = Path(self.temp.name) / "unrelated"
        outside.mkdir()
        (outside / "sentinel").write_text("untouched")
        (self.root / ".demo-data").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError): PREPARE.prepare(self.root, True)
        self.assertEqual((outside / "sentinel").read_text(), "untouched")
        (self.root / ".demo-data").unlink()
        home = PREPARE.prepare(self.root)
        (home / PREPARE.MARKER).write_text('{"synthetic": false}')
        with self.assertRaises(ValueError): PREPARE.prepare(self.root, True)

    def test_fixture_or_reused_vault_symlinks_are_rejected(self):
        link = self.root / "demo" / "vault" / "unexpected.md"
        link.symlink_to(self.root / "scripts" / "demo.sh")
        with self.assertRaises(ValueError): PREPARE.prepare(self.root)
        self.assertFalse((self.root / ".demo-data").exists())
        link.unlink()
        home = PREPARE.prepare(self.root)
        (home / "vault" / "unexpected.md").symlink_to(self.root / "scripts" / "demo.sh")
        with self.assertRaises(ValueError): PREPARE.prepare(self.root, True)

    def test_seed_parent_symlink_is_rejected_before_copying(self):
        original = self.root / "demo"
        moved = self.root / "synthetic-fixture-moved"
        original.rename(moved)
        original.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(ValueError): PREPARE.prepare(self.root)
        self.assertFalse((self.root / ".demo-data").exists())

    def test_inherited_vault_home_and_reserved_port_are_rejected(self):
        unrelated = Path(self.temp.name) / "unrelated"
        unrelated.mkdir()
        (unrelated / "sentinel").write_text("untouched")
        result = self.run_script("--prepare-only", extra_env={"VAULT_HOME": str(unrelated)})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("VAULT_HOME", result.stderr)
        self.assertEqual((unrelated / "sentinel").read_text(), "untouched")
        for port in ("8787", "08787", "0", "65536", "bad"):
            self.assertNotEqual(self.run_script("--prepare-only", extra_env={"NEURON_DEMO_PORT": port}).returncode, 0)
        self.assertFalse((self.root / ".demo-data").exists())

    def test_default_start_explicitly_uses_independent_home_and_port(self):
        # A controlled stub proves wiring without starting Java or touching a
        # developer's current process, ports, vault or cloud settings.
        start = self.root / "scripts" / "start.sh"
        start.write_text('#!/usr/bin/env bash\nset -eu\nif [[ "${1:-}" == "--check" ]]; then exit 0; fi\nprintf "%s\\n%s\\n" "$VAULT_HOME" "$NEURON_PORT" > startup-capture.txt\n')
        start.chmod(0o755)
        result = self.run_script(extra_env={"NEURON_PORT": "8787"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "startup-capture.txt").read_text().splitlines(), [str(self.root / ".demo-data"), "8790"])
        self.assertFalse((self.root / "data").exists())

    def test_missing_build_does_not_create_demo_data(self):
        start = self.root / "scripts" / "start.sh"
        start.write_text('#!/usr/bin/env bash\nexit 1\n')
        start.chmod(0o755)
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertFalse((self.root / ".demo-data").exists())

    def test_fixture_links_resolve_and_all_notes_declare_synthetic_origin(self):
        notes = list((self.root / "demo" / "vault").rglob("*.md"))
        bodies = [p.read_text(encoding="utf-8") for p in notes]
        titles = {re.search(r"^# (.+)$", body, re.M).group(1) for body in bodies}
        self.assertEqual(len(titles), 48)
        links = []
        for body in bodies:
            self.assertIn("合成演示资料", body)
            self.assertIn("完全虚构", body)
            self.assertRegex(body, r"(?m)^tags: \[[^\]]+\]$")
            for target in re.findall(r"\[\[([^\]]+)\]\]", body):
                self.assertIn(target, titles)
                links.append(target)
        self.assertGreater(len(links), 180)
        self.assertEqual(len(set(links)), 48)
        self.assertEqual((self.root / "demo" / "vault" / "assets" / "demo" / "event-flow.png").read_bytes()[:8], b"\x89PNG\r\n\x1a\n")


if __name__ == "__main__":
    unittest.main()
