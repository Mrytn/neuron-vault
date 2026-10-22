import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from import_youdao import DocxConverter, ImportProblem, LocalApi, run

HEAD = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>'
TAIL = '</w:body></w:document>'
IMAGE = b'\x89PNG\r\n\x1a\nLOCAL_IMAGE_SENTINEL'


def fixture(path, protected=False, extra=None):
    body = '''<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>原始标题</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">原始中文 A &amp; B </w:t></w:r><w:hyperlink r:id="rLink"><w:r><w:t>超链接文字</w:t></w:r></w:hyperlink></w:p>
<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">if (a &lt; b) {</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">  return "原样";</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t>}</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>列一</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>列二</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" descr="原图"/><a:blip r:embed="rImage"/></wp:inline></w:drawing></w:r></w:p>
<w:p><w:r><w:drawing><wp:inline><a:blip r:link="rExternal"/></wp:inline></w:drawing></w:r></w:p>'''
    rels = '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rLink" Type="hyperlink" Target="https://example.invalid/original?x=1&amp;y=2" TargetMode="External"/><Relationship Id="rImage" Type="image" Target="media/image1.png"/><Relationship Id="rExternal" Type="image" Target="https://example.invalid/remote.png" TargetMode="External"/></Relationships>'''
    styles = '''<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style><w:style w:styleId="Code"><w:name w:val="Code"/></w:style></w:styles>'''
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('word/document.xml', HEAD + body + TAIL)
        z.writestr('word/_rels/document.xml.rels', rels)
        z.writestr('word/styles.xml', styles)
        z.writestr('word/media/image1.png', IMAGE)
        if protected:
            z.writestr('word/settings.xml', '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:documentProtection w:enforcement="1"/></w:settings>')
        for name, value in (extra or {}).items():
            z.writestr(name, value)


class FakeApi:
    def __init__(self, vault):
        self.vault, self.payloads, self.known = vault, [], set()
        vault.mkdir(parents=True)
    def request(self, path, body=None):
        if path == '/api/settings':
            return {'vaultPath': str(self.vault)}
        assert path == '/api/import'
        self.payloads.append(body)
        note = body['notes'][0]
        fp = (note['sourceId'], note['content'])
        if fp in self.known:
            return {'imported': 0, 'skipped': 1, 'notes': []}
        self.known.add(fp)
        return {'imported': 1, 'skipped': 0, 'notes': [{'id': 'stable-test-id', 'path': note['folder'] + '/' + note['title'] + '.md'}]}


class ImportYoudaoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.doc = self.root / 'download.docx'
        fixture(self.doc)
    def tearDown(self):
        self.tmp.cleanup()
    def row(self, **updates):
        result = {'title': '原始笔记', 'folder': '有道/技术', 'sourceUrl': 'https://note.youdao.com/source', 'sourceId': 'source-123', 'downloadPath': str(self.doc)}
        result.update(updates)
        return result
    def test_preserves_text_table_code_hyperlinks_and_nested_image_paths(self):
        with patch('urllib.request.urlopen', side_effect=AssertionError('network forbidden')):
            result = DocxConverter(self.doc, 'source-123', '有道/技术').convert()
        self.assertIn('# 原始标题', result.markdown)
        self.assertIn('原始中文 A & B ', result.markdown)
        self.assertIn('[超链接文字](<https://example.invalid/original?x=1&y=2>)', result.markdown)
        self.assertIn('```\nif (a < b) {\n  return "原样";\n}\n```', result.markdown)
        self.assertIn('| 列一 | 列二 |\n| --- | --- |\n| 甲 | 乙 |', result.markdown)
        self.assertIn('![原图](<../../assets/youdao/source-123/', result.markdown)
        self.assertIn('[外部图片：图片](<https://example.invalid/remote.png>)', result.markdown)
        self.assertEqual(1, result.image_count)
        self.assertEqual(1, result.image_references)
        self.assertEqual([IMAGE], list(result.assets.values()))
        self.assertGreater(result.text_characters, 20)
    def test_dry_run_does_not_call_api_or_write_data(self):
        result = run([self.row()], None, self.root / 'data', True, None)
        self.assertEqual('ready', result['notes'][0]['status'])
        self.assertFalse((self.root / 'data').exists())
    def test_import_backups_assets_sha_and_idempotent_api_content(self):
        api = FakeApi(self.root / 'data/vault')
        report = run([self.row()], api, self.root / 'data', False, None)
        entry = report['notes'][0]
        self.assertEqual('imported', entry['status'])
        self.assertEqual(hashlib.sha256(self.doc.read_bytes()).hexdigest(), entry['sourceSha256'])
        self.assertEqual(self.doc.read_bytes(), Path(entry['originalPath']).read_bytes())
        for asset in entry['assets']:
            self.assertEqual(IMAGE, (api.vault / asset).read_bytes())
        self.assertEqual(self.row()['sourceUrl'], api.payloads[0]['notes'][0]['sourceUrl'])
        repeat = run([self.row()], api, None, False, None)
        self.assertEqual('skipped_duplicate', repeat['notes'][0]['status'])
        self.assertEqual(api.payloads[0], api.payloads[1])
    def test_locked_and_failed_entries_are_skipped_without_reading(self):
        with patch.object(DocxConverter, 'convert', side_effect=AssertionError('must not read')):
            result = run([self.row(locked=True, downloadPath='/missing.docx'), self.row(status='export_failed')], None, None, True, None)
        self.assertEqual(2, result['counts']['skipped'])
    def test_protected_and_zip_traversal_are_rejected(self):
        fixture(self.doc, protected=True)
        with self.assertRaisesRegex(ImportProblem, '保护'):
            DocxConverter(self.doc, 'a', '').convert()
        fixture(self.doc, extra={'../../escape.txt': 'escape'})
        with self.assertRaisesRegex(ImportProblem, '路径'):
            DocxConverter(self.doc, 'a', '').convert()
        self.assertFalse((self.root.parent / 'escape.txt').exists())
    def test_folder_and_remote_api_are_rejected(self):
        with self.assertRaises(ImportProblem):
            DocxConverter(self.doc, 'a', '../escape')
        for url in ['https://example.com', 'http://127.0.0.1@evil.example', 'http://localhost:8787/api']:
            with self.assertRaises(ImportProblem):
                LocalApi(url)
    def test_symlink_destination_and_mismatched_vault_are_rejected(self):
        api = FakeApi(self.root / 'data/vault')
        with self.assertRaises(ImportProblem):
            run([self.row()], api, self.root / 'wrong', False, None)
        outside = self.root / 'outside'
        outside.mkdir()
        (api.vault / 'assets').symlink_to(outside, target_is_directory=True)
        result = run([self.row()], api, None, False, None)
        self.assertEqual('error', result['notes'][0]['status'])
        self.assertEqual([], list(outside.iterdir()))
        self.assertEqual([], api.payloads)
    def test_changed_source_retains_original_backup(self):
        api = FakeApi(self.root / 'data/vault')
        first = run([self.row()], api, None, False, None)
        original = Path(first['notes'][0]['originalPath']).read_bytes()
        fixture(self.doc, extra={'docProps/new.xml': '<changed/>'})
        second = run([self.row()], api, None, False, None)
        self.assertNotEqual(first['notes'][0]['originalPath'], second['notes'][0]['originalPath'])
        self.assertEqual(original, Path(first['notes'][0]['originalPath']).read_bytes())


if __name__ == '__main__':
    unittest.main()
