package local.neuronvault;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.zip.ZipInputStream;
import static local.neuronvault.Models.*;
import static org.assertj.core.api.Assertions.*;

class VaultServiceTest {
    @TempDir Path temp;
    VaultService vault;
    @BeforeEach void setUp() throws Exception { vault = new VaultService(temp.resolve("data"), new ObjectMapper()); }
    Note create(String title, String content) throws Exception { return vault.create(new NoteInput(title, "", content, null)); }

    @Test void markdownIsRawAndIdentitySurvivesUpdatesAndRestart() throws Exception {
        String raw = "---\ntags: [Java, 中文]\n---\n# 我的笔记\n\n原始 Markdown\n";
        Note note = create("我的笔记", raw);
        assertThat(Files.readString(vault.vaultPath().resolve(note.path()))).isEqualTo(raw);
        Note moved = vault.update(note.id(), new NoteInput("新的标题", "学习/AI", raw + "更多内容\n", note.revision()));
        assertThat(moved.id()).isEqualTo(note.id());
        assertThat(moved.path()).isEqualTo("学习/AI/新的标题.md");
        assertThat(Files.exists(vault.vaultPath().resolve(note.path()))).isFalse();
        VaultService restarted = new VaultService(temp.resolve("data"), new ObjectMapper());
        assertThat(restarted.get(note.id()).content()).isEqualTo(raw + "更多内容\n");
    }
    @Test void staleRevisionNeverOverwritesExternalEdit() throws Exception {
        Note note = create("外部编辑", "original");
        Files.writeString(vault.vaultPath().resolve(note.path()), "external change");
        assertThatThrownBy(() -> vault.update(note.id(), new NoteInput(note.title(), "", "overwrite", note.revision())))
                .isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.status).isEqualTo(409));
        assertThat(vault.get(note.id()).content()).isEqualTo("external change");
    }
    @Test void externalFileAndExternalRenameAreDiscovered() throws Exception {
        Path file = vault.vaultPath().resolve("外部.md"); Files.writeString(file, "# 外部标题\n新文件");
        NoteSummary found = vault.list().notes().get(0);
        Files.move(file, vault.vaultPath().resolve("改名.md"));
        assertThat(vault.list().notes()).singleElement().satisfies(n -> { assertThat(n.id()).isEqualTo(found.id()); assertThat(n.path()).isEqualTo("改名.md"); });
    }
    @Test void importIsIdempotentWithoutOverwritingRelatedOrUnrelatedNotes() throws Exception {
        create("同名", "用户原有正文");
        String raw = "---\ntags:\n  - 工程\n  - java\n---\n导入正文 #中文标签\n";
        ImportNote source = new ImportNote("同名", "导入", raw, "https://note.youdao.com/source", "youdao-1");
        ImportResult first = vault.importNotes(new ImportRequest(List.of(source)));
        assertThat(first.imported()).isEqualTo(1);
        assertThat(vault.get(first.notes().get(0).id()).content()).isEqualTo(raw);
        assertThat(first.notes().get(0).tags()).contains("工程", "java", "中文标签");
        ImportResult duplicate = vault.importNotes(new ImportRequest(List.of(source)));
        assertThat(duplicate.imported()).isZero(); assertThat(duplicate.skipped()).isEqualTo(1);
        ImportResult updatedSource = vault.importNotes(new ImportRequest(List.of(new ImportNote("同名", "导入", raw + "更新", source.sourceUrl(), source.sourceId()))));
        assertThat(updatedSource.imported()).isEqualTo(1); assertThat(vault.list().stats().notes()).isEqualTo(3);
        assertThat(vault.list().notes()).anySatisfy(n -> assertThat(n.excerpt()).contains("用户原有正文"));
    }
    @Test void graphContainsOnlyActualLinksAndSharedTagsAndBacklinks() throws Exception {
        Note target = create("唯一中文标题", "---\ntags: [共享标签]\n---\n目标正文");
        Note unlinked = create("无关联", "没有关联");
        Note source = create("来源", "[[唯一中文标题]]\n[再次引用](唯一中文标题.md)\n#共享标签\n`[[无关联]]`\n```md\n[[无关联]]\n```");
        Graph graph = vault.graph();
        assertThat(graph.edges()).filteredOn(e -> e.type().equals("link")).singleElement().satisfies(e -> {
            assertThat(e.source()).isEqualTo(source.id()); assertThat(e.target()).isEqualTo(target.id());
        });
        assertThat(graph.edges()).anyMatch(e -> e.type().equals("tag") && e.label().equals("共享标签"));
        assertThat(graph.edges()).noneMatch(e -> e.source().equals(unlinked.id()) || e.target().equals(unlinked.id()));
        assertThat(vault.get(target.id()).backlinks()).extracting(NoteSummary::id).containsExactly(source.id());
        assertThat(vault.get(source.id()).outgoing()).extracting(NoteSummary::id).containsExactly(target.id());
    }
    @Test void chineseAndLatinSearchPreserveSourceLine() throws Exception {
        Note n = create("检索测试", "# 标题\n无关内容\n向量检索需要评估召回率和准确性。\nSpring Boot + JAVA");
        SearchHit hit = vault.search("向量检索").get(0);
        assertThat(hit.id()).isEqualTo(n.id()); assertThat(hit.line()).isEqualTo(3); assertThat(hit.excerpt()).contains("向量检索");
        assertThat(vault.search("java").get(0).line()).isEqualTo(4);
        assertThat(vault.search("不存在的火星词汇")).isEmpty();
    }
    @Test void trashRestoreKeepsIdAndDoesNotOverwriteNewSameName() throws Exception {
        Note original = create("恢复测试", "旧正文"); vault.delete(original.id());
        assertThat(vault.list().notes()).isEmpty(); assertThat(vault.trash()).hasSize(1);
        Note other = create("恢复测试", "新正文");
        Note restored = vault.restore(original.id());
        assertThat(restored.id()).isEqualTo(original.id()); assertThat(restored.content()).isEqualTo("旧正文");
        assertThat(restored.path()).isNotEqualTo(other.path()); assertThat(vault.get(other.id()).content()).isEqualTo("新正文");
        assertThat(vault.trash()).isEmpty();
    }
    @Test void traversalAndSymlinksCannotReachOutsideVault() throws Exception {
        assertThatThrownBy(() -> vault.create(new NoteInput("攻击", "../outside", "bad", null))).isInstanceOf(ApiException.class);
        Path outside = temp.resolve("outside"); Files.createDirectory(outside); Files.writeString(outside.resolve("secret.md"), "secret");
        Files.createSymbolicLink(vault.vaultPath().resolve("linked"), outside);
        Files.createSymbolicLink(vault.vaultPath().resolve("secret.md"), outside.resolve("secret.md"));
        assertThat(vault.list().notes()).isEmpty();
        assertThatThrownBy(() -> vault.create(new NoteInput("new", "linked", "bad", null))).isInstanceOf(ApiException.class);
        assertThat(Files.readString(outside.resolve("secret.md"))).isEqualTo("secret");
        assertThatThrownBy(() -> new VaultService(vault.vaultPath().resolve("linked"), new ObjectMapper())).isInstanceOf(ApiException.class);
    }
    @Test void zipIncludesMarkdownAndAssetsButNoTrashSecretsOrSymlinks() throws Exception {
        Note keep = create("保留", "保留正文"); Note deleted = create("删除", "TRASH_SENTINEL"); vault.delete(deleted.id());
        Files.createDirectories(vault.vaultPath().resolve("assets")); Files.write(vault.vaultPath().resolve("assets/image.png"), new byte[]{1,2,3});
        Files.writeString(vault.vaultPath().resolve(".env"), "SECRET_SENTINEL");
        Files.writeString(temp.resolve("outside.txt"), "OUTSIDE_SENTINEL"); Files.createSymbolicLink(vault.vaultPath().resolve("outside.txt"), temp.resolve("outside.txt"));
        Map<String, String> entries = new HashMap<>();
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(vault.exportZip()), StandardCharsets.UTF_8)) {
            for (var entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) entries.put(entry.getName(), new String(zip.readAllBytes(), StandardCharsets.UTF_8));
        }
        assertThat(entries.keySet()).containsExactlyInAnyOrder(keep.path(), "assets/image.png");
        assertThat(entries.values().toString()).doesNotContain("TRASH_SENTINEL", "SECRET_SENTINEL", "OUTSIDE_SENTINEL");
    }
    @Test void backendCwdResolvesProjectDataRoot() throws Exception {
        Path project = temp.resolve("project"); Files.createDirectories(project.resolve("backend")); Files.writeString(project.resolve("CONTRACT.md"), "contract");
        assertThat(SafeFiles.resolveRoot("", project.resolve("backend"))).isEqualTo(project.resolve("data"));
        assertThat(SafeFiles.resolveRoot(temp.resolve("custom").toString(), project)).isEqualTo(temp.resolve("custom"));
    }
    @Test void longChineseTitleUsesAValidPortableFilename() throws Exception {
        String title = "中文".repeat(90);
        Note note = create(title, "长标题正文");
        assertThat(note.title()).isEqualTo(title);
        assertThat(note.path().getBytes(StandardCharsets.UTF_8).length).isLessThan(200);
        assertThat(vault.get(note.id()).content()).isEqualTo("长标题正文");
    }
    @Test void excerptSkipsImagesAndPureLinksWithoutChangingOriginalSearchLines() throws Exception {
        String raw = "# 标题\n\n![图片](<../assets/long-image-path.png>)\n\n[原始地址](https://example.com/very/long/path)\nhttps://example.com/other\n\n第一段包含独特词。\n这是同一段的续行。\n\n第二段不进入摘要。";
        Note note = create("摘要测试", raw);
        assertThat(note.excerpt()).isEqualTo("第一段包含独特词。 这是同一段的续行。");
        assertThat(note.content()).isEqualTo(raw);
        assertThat(vault.get(note.id()).wordCount()).isEqualTo(note.wordCount());
        SearchHit hit = vault.search("独特词").get(0);
        assertThat(hit.line()).isEqualTo(8);
        assertThat(hit.excerpt()).isEqualTo("第一段包含独特词。");
        assertThat(vault.search("long-image-path").get(0).line()).isEqualTo(3);
    }
    @Test void imageOnlyNoteShowsImageCountAndInlineLinksKeepReadableLabels() throws Exception {
        Note images = create("图集", "---\ntags: [图片]\n---\n# 图集\n\n![图一](<assets/one.png>)\n\n![图二](assets/two.png)\n\n[来源](https://example.com)");
        assertThat(images.excerpt()).isEqualTo("图片笔记 · 2 张图片");
        Note prose = create("说明", "请阅读[工程文档](https://example.com/docs)并核对结果。\n\n其他段落");
        assertThat(prose.excerpt()).isEqualTo("请阅读工程文档并核对结果。");
    }
}
