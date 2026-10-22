#!/usr/bin/env python3
"""Exercise a disposable Neuron Vault instance using only Python's stdlib.

Never run against your daily vault. Start the backend with VAULT_HOME set to an
empty directory named /tmp/neuron-vault-acceptance-<anything>, then run:

    python3 scripts/acceptance.py --vault-home "$VAULT_HOME" \
        --base-url http://127.0.0.1:8787

The supplied home must contain both this instance's vault and settings. The
script deliberately leaves its disposable home available for failure analysis;
stop that backend before deleting the home. It never contacts a model provider.
The only key used is a unique fake sentinel pointing at a closed loopback port.
"""

from __future__ import annotations

import argparse
import io
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile


class Failure(Exception):
    """An actionable acceptance-test failure."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Failure(message)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Failure(f"Unexpected HTTP redirect ({code}); no redirect followed")


class Client:
    def __init__(self, base_url: str):
        parsed = urllib.parse.urlsplit(base_url)
        try:
            is_loopback = ipaddress.ip_address(parsed.hostname or "").is_loopback
        except ValueError:
            is_loopback = parsed.hostname == "localhost"
        require(parsed.scheme == "http" and is_loopback, "Only an HTTP loopback URL is permitted")
        require(not parsed.username and not parsed.password, "Credentials in URLs are forbidden")
        require(parsed.path in ("", "/") and not parsed.query and not parsed.fragment,
                "--base-url must be an origin without a path, query, or fragment")
        self.base = base_url.rstrip("/")
        # Local tests must not go through an inherited corporate/cloud proxy.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method: str, path: str, body=None, headers=None):
        require(path.startswith("/api/"), "Tests may only request this instance's /api routes")
        request_headers = {"Accept": "application/json"}
        request_headers.update(headers or {})
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=data, headers=request_headers, method=method)
        try:
            with self.opener.open(request, timeout=15) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read()
        except urllib.error.URLError as error:
            raise Failure(f"Cannot reach test backend: {error.reason}") from error

    def json(self, method: str, path: str, body=None, *, status=(200,), headers=None):
        actual, _, raw = self.request(method, path, body, headers)
        expected = (status,) if isinstance(status, int) else tuple(status)
        require(actual in expected, f"{method} {path}: expected HTTP {expected}, got {actual}; "
                f"response={raw[:300].decode('utf-8', errors='replace')}")
        try:
            parsed = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise Failure(f"{method} {path}: response was not UTF-8 JSON") from error
        require(isinstance(parsed, dict), f"{method} {path}: expected a JSON object")
        if actual >= 400:
            require(isinstance(parsed.get("error"), str) and parsed["error"],
                    f"{method} {path}: errors must have a nonempty error string")
        return parsed


class Acceptance:
    def __init__(self, client: Client, home: Path):
        self.client = client
        self.home = home
        self.vault = None
        self.token = uuid.uuid4().hex[:10]
        self.folder = f"__acceptance_{self.token}"
        self.ids = []
        self.checks = []
        self.secret = f"acceptance-fake-key-{self.token}-NOT-A-REAL-KEY"

    def passed(self, name: str):
        self.checks.append(name)
        print(f"PASS {name}", flush=True)

    @staticmethod
    def note_path(note_id: str) -> str:
        return "/api/notes/" + urllib.parse.quote(str(note_id), safe="")

    def get(self, note_id: str):
        return self.client.json("GET", self.note_path(note_id))

    def create(self, title: str, content: str, folder=None):
        note = self.client.json("POST", "/api/notes", {
            "title": title, "folder": folder or self.folder, "content": content,
        }, status=(200, 201))
        require(isinstance(note.get("id"), str) and note["id"], "Created note has no stable id")
        self.ids.append(note["id"])
        require(note.get("content") == content, "Creating a note changed its Markdown content")
        require(note.get("title") == title, "Created note title differs from request")
        require(bool(note.get("revision")), "Created note has no revision")
        return note

    def edit(self, note: dict, content: str, *, status=(200,)):
        return self.client.json("PUT", self.note_path(note["id"]), {
            "title": note["title"], "folder": note["folder"],
            "content": content, "revision": note["revision"],
        }, status=status)

    def stored_path(self, note: dict) -> Path:
        path = Path(note["path"])
        resolved = (path if path.is_absolute() else self.vault / path).resolve()
        require(resolved.is_relative_to(self.vault), "Server returned a path outside its vault")
        require(resolved.is_file(), "The returned note path does not identify an on-disk Markdown file")
        return resolved

    def safety_preflight(self):
        require(self.home.name.startswith("neuron-vault-acceptance-"),
                "Refusing to mutate: --vault-home basename must start with neuron-vault-acceptance-")
        require(self.home.is_dir(), "--vault-home does not exist; start a dedicated backend first")
        temp_root = Path(tempfile.gettempdir()).resolve()
        require(self.home.is_relative_to(temp_root) and self.home != temp_root,
                f"Refusing to mutate: test home must be a child of {temp_root}")
        health = self.client.json("GET", "/api/health")
        require(health.get("status") == "ok", "Backend health check failed")
        settings = self.client.json("GET", "/api/settings")
        require(settings.get("configured") is False,
                "Refusing to test an instance with model credentials; use a new dedicated VAULT_HOME")
        require(isinstance(settings.get("vaultPath"), str), "settings.vaultPath is missing")
        self.vault = Path(settings["vaultPath"]).resolve()
        require(self.vault.is_relative_to(self.home),
                f"Backend vaultPath {self.vault} is not inside the supplied disposable home {self.home}")
        require(self.vault.is_dir(), "Backend vaultPath is not an existing directory")
        self.assert_redacted(settings)
        notes = self.client.json("GET", "/api/notes")["notes"]
        require(not notes, "Dedicated test vault must start empty; refusing to test pre-existing notes")
        trash = self.client.json("GET", "/api/trash")["notes"]
        require(not trash, "Dedicated test trash must start empty")
        (self.home / "ACCEPTANCE-TEST-DATA.txt").write_text(
            "Disposable Neuron Vault acceptance data. Stop its backend before deleting this directory.\n",
            encoding="utf-8")
        self.passed("isolated empty vault, loopback access, and no model key")

    def assert_redacted(self, settings: dict):
        serialized = json.dumps(settings, ensure_ascii=False)
        require(self.secret not in serialized, "Settings API exposed its key")
        forbidden = {"apikey", "api_key", "authorization", "token", "secret"}
        def visit(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    require(key.lower() not in forbidden, "Settings response contains a credential field")
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)
        visit(settings)

    def run(self):
        self.safety_preflight()
        title_a = f"中文验收-{self.token}-知识溯源"
        title_b = f"中文验收-{self.token}-工程应用"
        tag = f"验收共同{self.token}"
        keyword = "琥珀知识验收"
        original = (f"# {title_a}\n\n{keyword}的答案：导入笔记时保留来源链接，引用应定位到原文。\n"
                    f"\n#{tag}\n")
        a = self.create(title_a, original)
        require(self.get(a["id"])["content"] == original, "Read-after-create failed")
        listed = self.client.json("GET", "/api/notes")
        require(a["id"] in {n["id"] for n in listed["notes"]}, "Created note is absent from listing")
        require(self.folder in listed["folders"], "New folder is absent from folder listing")
        require(listed["stats"]["notes"] == 1, "Note statistics are incorrect")
        self.passed("create/list/read Chinese UTF-8 Markdown")

        q = urllib.parse.urlencode({"q": keyword})
        hits = self.client.json("GET", "/api/search?" + q)["results"]
        hit = next((h for h in hits if h["id"] == a["id"]), None)
        require(hit is not None, "Chinese search did not return the matching note")
        require(isinstance(hit.get("line"), int) and hit["line"] >= 1, "Search line must be 1-based")
        source_lines = self.stored_path(a).read_text(encoding="utf-8").splitlines()
        require(hit["line"] <= len(source_lines) and keyword in source_lines[hit["line"] - 1],
                "Search line does not point to its matching source line")
        require(keyword in hit.get("excerpt", ""), "Search excerpt omits the matching Chinese phrase")
        self.passed("Chinese search with a correct original source line")

        a_saved = self.edit(a, original + "\n更新标记：已完成人工核验。\n")
        require(a_saved["revision"] != a["revision"], "Saving different content did not change revision")
        self.edit(a, "stale overwrite must never be saved", status=409)
        require(self.get(a["id"])["content"] == a_saved["content"], "Stale update overwrote current content")
        self.passed("edit and reject stale revision with HTTP 409")

        disk_path = self.stored_path(a_saved)
        with disk_path.open("a", encoding="utf-8") as file:
            file.write("\n外部编辑标记：普通 Markdown 编辑器也能修改。\n")
        self.client.json("GET", "/api/notes")
        a_external = self.get(a["id"])
        require("外部编辑标记" in a_external["content"], "External disk edit was not discovered on refresh")
        require(a_external["revision"] != a_saved["revision"], "External edit did not update revision")
        self.edit(a_saved, "stale external overwrite", status=409)
        self.passed("external Markdown edits are visible and protected from stale writes")

        b = self.create(title_b, f"# {title_b}\n\n实际引用 [[{title_a}]]。\n\n#{tag}\n")
        c_marker = f"isolated-trash-only-content-{self.token}"
        c = self.create(f"无关联验收-{self.token}", f"# 独立记录\n\n{c_marker}\n")
        a_linked = self.get(a["id"])
        b_linked = self.get(b["id"])
        require(tag in a_linked["tags"] and tag in b_linked["tags"], "Chinese inline tags were not indexed")
        require(b["id"] in {n["id"] for n in a_linked["backlinks"]}, "Backlinks omit the real wikilink")
        require(a["id"] in {n["id"] for n in b_linked["outgoing"]}, "Outgoing links omit the real wikilink")
        graph = self.client.json("GET", "/api/graph")
        nodes = {node["id"] for node in graph["nodes"]}
        require({a["id"], b["id"], c["id"]}.issubset(nodes), "Graph omits existing note nodes")
        require(any(e["source"] == b["id"] and e["target"] == a["id"] and e["type"] == "link"
                    for e in graph["edges"]), "Graph has no actual directed wikilink edge")
        require(any({e["source"], e["target"]} == {a["id"], b["id"]} and e["type"] == "tag"
                    for e in graph["edges"]), "Graph has no actual shared-tag edge")
        require(not any(c["id"] in (e["source"], e["target"]) for e in graph["edges"]),
                "Graph invented an edge for an unrelated note")
        require(all(e["source"] in nodes and e["target"] in nodes for e in graph["edges"]),
                "Graph contains dangling edges")
        self.passed("Chinese tags, backlinks, outgoing links, and real-only graph edges")

        relative_a = os.path.relpath(self.stored_path(a_external), self.stored_path(b).parent).replace(os.sep, "/")
        markdown_note = self.create(f"Markdown引用验收-{self.token}",
                                    f"# 文件链接\n\n[来源]({urllib.parse.quote(relative_a, safe='/')})\n")
        require(a["id"] in {n["id"] for n in self.get(markdown_note["id"])["outgoing"]},
                "Relative Markdown link did not resolve to its real target")
        self.passed("relative Markdown links resolve to actual notes")

        raw_import = "# 有道导入测试\n\n原始内容保留：中文、空行和 `code`。\n\n"
        source_url = f"https://note.youdao.com/web/#/file/recent/note/acceptance-{self.token}/"
        payload = {"notes": [{"title": f"导入验收-{self.token}", "folder": self.folder,
                              "content": raw_import, "sourceUrl": source_url,
                              "sourceId": f"acceptance-{self.token}"}]}
        imported = self.client.json("POST", "/api/import", payload, status=(200, 201))
        require(imported.get("imported") == 1 and imported.get("skipped") == 0,
                "First source import was not counted correctly")
        require(len(imported.get("notes", [])) == 1, "Import did not return one note")
        imported_id = imported["notes"][0]["id"]
        self.ids.append(imported_id)
        imported_note = self.get(imported_id)
        require(imported_note["content"] == raw_import, "Import changed original Markdown content")
        require(imported_note.get("sourceUrl") == source_url, "Import lost its source URL")
        repeated = self.client.json("POST", "/api/import", payload, status=(200, 201))
        require(repeated.get("imported") == 0 and repeated.get("skipped") == 1,
                "Repeating the same source was not idempotent")
        require(len(self.client.json("GET", "/api/notes")["notes"]) == len(self.ids),
                "Repeated import created an extra note")
        self.passed("source import preserves raw content, URL, and is idempotent")

        answer = self.client.json("POST", "/api/ask", {"question": keyword})
        require(answer.get("mode") == "local", "No-key /ask must honestly report local mode")
        require(a["id"] in {s["id"] for s in answer.get("sources", [])},
                "Local /ask omitted the relevant note source")
        require(isinstance(answer.get("answer"), str) and answer["answer"].strip(),
                "Local /ask returned no answer")
        require(keyword in answer["answer"] or any(keyword in s.get("excerpt", "")
                                                  for s in answer["sources"]),
                "Local /ask neither quotes nor exposes its supporting excerpt")
        for source in answer["sources"]:
            require(isinstance(source.get("line"), int) and source["line"] > 0,
                    "Ask source has no usable source-line location")
            require(bool(source.get("path")) and bool(source.get("title")), "Ask source metadata is incomplete")
        miss = self.client.json("POST", "/api/ask", {"question": "zxqmissing" + uuid.uuid4().hex})
        require(miss.get("mode") == "local" and miss.get("sources") == [],
                "No-match /ask must remain local and return no fabricated sources")
        require(any(marker in miss.get("answer", "").lower()
                    for marker in ("未", "没有", "无法", "不足", "no ", "not found", "cannot")),
                "No-match answer does not clearly acknowledge missing evidence")
        self.passed("no-key extractive answers cite sources; no-match answers abstain")

        self.client.json("DELETE", self.note_path(b["id"]))
        self.client.json("GET", self.note_path(b["id"]), status=404)
        require(b["id"] in {n["id"] for n in self.client.json("GET", "/api/trash")["notes"]},
                "Deleted note is absent from recoverable trash")
        require(b["id"] not in {n["id"] for n in self.client.json("GET", "/api/graph")["nodes"]},
                "Deleted note remains in active graph")
        restored = self.client.json("POST", "/api/trash/" + urllib.parse.quote(b["id"], safe="") + "/restore")
        require(restored.get("id") == b["id"], "Restoring a note changed its stable id")
        require(restored.get("content") == b["content"], "Restoring a note changed its original content")
        require(b["id"] in {n["id"] for n in self.get(a["id"])["backlinks"]},
                "Restored note's backlink was not rebuilt")
        self.client.json("DELETE", self.note_path(c["id"]))
        self.passed("recoverable delete, stable-id restore, and rebuilt backlinks")

        self.security_checks()
        self.export_checks(a, c_marker)
        print(f"\nPASS all {len(self.checks)} acceptance groups.", flush=True)
        print("Cloud-model behavior was NOT exercised: no real provider key or paid API was used.")
        print(f"All test mutations were isolated to: {self.home}")
        print("Stop the dedicated backend before removing this disposable directory.")

    def security_checks(self):
        for folder in ("../acceptance-outside", "/tmp/acceptance-outside", "a/../../acceptance-outside"):
            self.client.json("POST", "/api/notes", {
                "title": f"路径拒绝-{self.token}", "folder": folder, "content": "must not be written",
            }, status=(400, 403, 422))
        # A servlet container may reject encoded path separators before its
        # JSON API handler runs. The essential behavior for this malformed URL
        # is rejection, while ordinary application errors are checked as JSON.
        rejected, _, _ = self.client.request("GET", "/api/notes/..%2F..%2Facceptance-outside")
        require(rejected in (400, 403, 404), "Encoded path traversal was not rejected")
        for method, path, body in (("GET", "/api/health", None),
                                   ("POST", "/api/notes", {"title": "forbidden-origin", "content": "no"})):
            self.client.json(method, path, body, headers={"Origin": "https://attacker.example"}, status=(400, 403))
        self.client.json("GET", "/api/health", headers={"Host": "attacker.example"}, status=(400, 403))
        allowed = self.client.json("GET", "/api/health", headers={"Origin": self.client.base})
        require(allowed.get("status") == "ok", "Valid same-origin request was rejected")
        self.passed("path traversal and unexpected Origin/Host rejected; same-origin accepted")

        outside = self.home / f"symlink-target-{self.token}.md"
        # When VAULT_HOME itself is the vault, put the target in a separate temp
        # directory instead; either way, no user-owned file is ever read.
        with tempfile.TemporaryDirectory(prefix="neuron-vault-acceptance-outside-") as directory:
            outside = Path(directory) / "private.md"
            marker = f"SymlinkPrivate{self.token}"
            outside.write_text(f"# External secret\n\n{marker}\n", encoding="utf-8")
            link = self.vault / f"acceptance-symlink-{self.token}.md"
            try:
                link.symlink_to(outside)
                hits = self.client.json("GET", "/api/search?" + urllib.parse.urlencode({"q": marker}))["results"]
                require(not hits, "Symlink exposed content outside the vault through search")
                code, _, raw = self.client.request("GET", "/api/export")
                require(code == 200, "Export failed when a symlink was present")
                with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                    require(not any(marker.encode() in archive.read(name) for name in archive.namelist()
                                    if not name.endswith("/")), "Export followed a symlink outside the vault")
            finally:
                if link.is_symlink():
                    link.unlink()
        self.passed("search and ZIP export do not follow vault symlinks")

    def export_checks(self, a: dict, trashed_marker: str):
        # All asks have already completed. A closed loopback URL is deliberately
        # used even with the fake key so no test can reach a real model endpoint.
        settings = self.client.json("PUT", "/api/settings", {
            "provider": "compatible", "baseUrl": "http://127.0.0.1:1/v1",
            "model": "acceptance-no-network", "apiKey": self.secret,
        })
        self.assert_redacted(settings)
        require(settings.get("configured") is True, "Settings did not register the fake key")
        fetched = self.client.json("GET", "/api/settings")
        self.assert_redacted(fetched)
        require(fetched.get("configured") is True, "Settings did not persist the fake key")
        preserved = self.client.json("PUT", "/api/settings", {
            "provider": "compatible", "baseUrl": "http://127.0.0.1:1/v1",
            "model": "acceptance-no-network", "apiKey": "",
        })
        self.assert_redacted(preserved)
        require(preserved.get("configured") is True, "A blank apiKey unexpectedly erased the existing key")

        secret_files = []
        for path in self.home.rglob("*"):
            if path.is_file() and not path.is_symlink() and path.stat().st_size < 2_000_000:
                if self.secret.encode() in path.read_bytes():
                    secret_files.append(path)
        require(secret_files, "Fake key was not persisted inside the isolated VAULT_HOME")
        for path in secret_files:
            require(not path.resolve().is_relative_to(self.vault), "Credential file is inside the Markdown vault")
            require(stat.S_IMODE(path.stat().st_mode) & 0o077 == 0,
                    "Credential file permits group/other access instead of owner-only permissions")
        self.passed("settings redact and preserve keys; saved credentials are outside vault and owner-only")

        status, _, raw = self.client.request("GET", "/api/export")
        require(status == 200, f"Export returned HTTP {status}")
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                files = [name for name in archive.namelist() if not name.endswith("/")]
                require(files, "ZIP export is empty")
                contents = []
                for name in files:
                    path = PurePosixPath(name)
                    require(not path.is_absolute() and ".." not in path.parts, "ZIP has unsafe entry paths")
                    lower_parts = {part.lower() for part in path.parts}
                    require(not lower_parts.intersection({"trash", ".trash", ".env", "settings.json", "credentials.json"}),
                            "ZIP includes a credential or trash path")
                    content = archive.read(name)
                    require(self.secret.encode() not in content, "ZIP export leaked the fake API key")
                    require(trashed_marker.encode() not in content, "ZIP export included deleted content")
                    contents.append(content)
                require(any(a["title"].encode() in content for content in contents),
                        "ZIP does not contain the live Chinese note")
        except zipfile.BadZipFile as error:
            raise Failure("Export did not return a valid ZIP") from error
        self.passed("ZIP contains live notes and excludes credentials, symlink contents, and trash")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="http://127.0.0.1:8787")
    parser.add_argument("--vault-home", required=True, type=Path,
                        help="Dedicated backend VAULT_HOME under /tmp named neuron-vault-acceptance-*")
    args = parser.parse_args()
    started = time.monotonic()
    try:
        require(not args.vault_home.is_symlink(), "Test home must not be a symlink")
        suite = Acceptance(Client(args.base_url), args.vault_home.resolve())
        suite.run()
    except (Failure, KeyError, OSError, ValueError) as error:
        # Never echo settings payloads or actual model credentials.
        message = str(error)
        if "suite" in locals():
            message = message.replace(suite.secret, "[REDACTED TEST KEY]")
        print(f"FAIL {message}", file=sys.stderr)
        print("Only use a fresh isolated test home for a rerun; never point this script at personal notes.",
              file=sys.stderr)
        return 1
    finally:
        print(f"Elapsed: {time.monotonic() - started:.2f}s", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
