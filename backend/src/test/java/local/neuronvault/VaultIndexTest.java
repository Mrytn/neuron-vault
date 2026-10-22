package local.neuronvault;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.nio.file.attribute.FileTime;
import java.util.*;
import static local.neuronvault.Models.*;
import static org.assertj.core.api.Assertions.*;

class VaultIndexTest {
    @TempDir Path temp;
    final ObjectMapper mapper = new ObjectMapper();

    VaultService fixture(List<VaultService.Meta> metadata, Map<String, String> bodies) throws Exception {
        Path root = temp.resolve("data");
        Files.createDirectories(root.resolve("vault")); Files.createDirectories(root.resolve(".metadata"));
        for (var entry : bodies.entrySet()) {
            Path file = root.resolve("vault").resolve(entry.getKey()); Files.createDirectories(file.getParent()); Files.writeString(file, entry.getValue());
        }
        mapper.writeValue(root.resolve(".metadata/index.json").toFile(), metadata);
        return new VaultService(root, mapper);
    }
    static VaultService.Meta meta(String id, String status) {
        var m = new VaultService.Meta(); m.id = id; m.sourceId = id; m.sourceStatus = status;
        m.title = "原始标题 " + id; m.path = "有道/AI/" + id + ".md";
        m.sourceCreatedAt = "2020-01-01T00:00:00Z"; m.sourceModifiedAt = "2025-01-01T00:00:00Z";
        m.sourceExportPath = "原始目录/" + id + ".md"; m.sourceHtmlPath = "assets/youdao-export/原始目录/" + id + ".html"; return m;
    }
    @Test void importedStatesRemainSearchableAndMetadataSurvivesRefreshAndRestart() throws Exception {
        var ok = meta("raw-valid-id", "ok"); var missing = meta("raw-missing-id", "missing_body"); var encrypted = meta("raw-encrypted-id", "encrypted");
        VaultService vault = fixture(List.of(ok, missing, encrypted), Map.of(ok.path, "可用的检索正文", missing.path, "检索：原始导出缺少正文", encrypted.path, "检索：原始笔记已加密"));
        assertThat(vault.list().notes()).extracting(NoteSummary::sourceStatus).containsExactlyInAnyOrder("ok", "missing_body", "encrypted");
        assertThat(vault.get(missing.id).sourceId()).isEqualTo(missing.id);
        assertThat(vault.get(missing.id).sourceHtmlPath()).isEqualTo(missing.sourceHtmlPath);
        assertThat(vault.list().notes()).allSatisfy(n -> assertThat(n.sourceHtmlPath()).startsWith("assets/youdao-export/"));
        assertThat(vault.get(missing.id).sourceStatus()).isEqualTo("missing_body");
        assertThat(vault.search("检索")).extracting(SearchHit::sourceStatus).containsExactlyInAnyOrder("ok", "missing_body", "encrypted");
        assertThat(vault.searchEvidence("检索")).extracting(SearchHit::id).containsExactly(ok.id);
        var saved = mapper.readTree(vault.root.resolve(".metadata/index.json").toFile());
        for (var item : saved) {
            assertThat(item.path("sourceCreatedAt").asText()).isEqualTo("2020-01-01T00:00:00Z");
            assertThat(item.path("sourceModifiedAt").asText()).isEqualTo("2025-01-01T00:00:00Z");
            assertThat(item.path("sourceExportPath").asText()).startsWith("原始目录/");
        }
        VaultService restarted = new VaultService(vault.root, mapper);
        assertThat(restarted.get(encrypted.id).sourceStatus()).isEqualTo("encrypted");
        vault.delete(missing.id); assertThat(vault.trash()).singleElement().extracting(NoteSummary::sourceStatus).isEqualTo("missing_body");
        assertThat(vault.restore(missing.id).sourceId()).isEqualTo(missing.id);
    }
    @Test void codeSamplesNeverBecomeTagsOrLinksAndReferenceLinksAreReal() throws Exception {
        VaultService vault = fixture(List.of(), Map.of());
        Note target = vault.create(new NoteInput("真实目标", "", "正文 #真实标签", null));
        String raw = "---\ntags: [显式标签]\n---\n正文 #真实标签\n\n"
                + "    #缩进代码\n    [[伪目标]]\n\n"
                + "> ````cpp\n> #include <x>\n> [[伪目标]]\n> ```\n> #define NAME\n> ````\n\n"
                + "`` #双反引号 ` [[伪目标]] ``\n\n<div>\n#HTML样例\n[[伪目标]]\n</div>\n\n"
                + "[参考链接][ref]\n\n[ref]: 真实目标.md\n\n~~~\n#未闭合代码\n[[伪目标]]";
        Note source = vault.create(new NoteInput("源笔记", "", raw, null));
        vault.create(new NoteInput("伪目标", "", "正文", null));
        assertThat(source.tags()).containsExactly("显式标签", "真实标签");
        assertThat(vault.graph().edges()).filteredOn(e -> e.type().equals("link")).singleElement().satisfies(e -> {
            assertThat(e.source()).isEqualTo(source.id()); assertThat(e.target()).isEqualTo(target.id());
        });
        assertThat(vault.get(source.id()).content()).isEqualTo(raw);
    }
    @Test void cacheDetectsSameSizeChangesWithRestoredMtimeAndExternalAddRemoveRename() throws Exception {
        VaultService vault = fixture(List.of(), Map.of("外部.md", "oldtext"));
        NoteSummary original = vault.list().notes().get(0); Path file = vault.vaultPath().resolve(original.path());
        FileTime time = Files.getLastModifiedTime(file); String revision = vault.get(original.id()).revision();
        Files.writeString(file, "newtext"); Files.setLastModifiedTime(file, time);
        assertThat(vault.get(original.id()).content()).isEqualTo("newtext");
        assertThatThrownBy(() -> vault.update(original.id(), new NoteInput(original.title(), "", "stale", revision)))
                .isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.status).isEqualTo(409));
        Files.move(file, vault.vaultPath().resolve("更名.md"));
        assertThat(vault.get(original.id()).path()).isEqualTo("更名.md");
        Files.writeString(vault.vaultPath().resolve("新增.md"), "外部新内容"); assertThat(vault.list().notes()).hasSize(2);
        Files.delete(vault.vaultPath().resolve("更名.md")); assertThat(vault.list().notes()).hasSize(1);
    }
    @Test void thousandNoteLibraryReusesContentAndGraphWithoutWalkingAssetsAsNotes() throws Exception {
        List<VaultService.Meta> metadata = new ArrayList<>(); Map<String, String> bodies = new LinkedHashMap<>();
        for (int i = 0; i < 1200; i++) {
            var m = meta("raw-" + i, "ok"); metadata.add(m);
            bodies.put(m.path, "# 笔记 " + i + "\n\n可检索工程经验 " + i + "\n\n```cpp\n#include <x>\n#define VALUE 1\n```\n\n#分组" + i % 60);
        }
        VaultService vault = fixture(metadata, bodies);
        for (int i = 0; i < 8000; i++) {
            Path asset = vault.vaultPath().resolve("assets/youdao/group" + i % 80 + "/asset" + i + ".bin");
            Files.createDirectories(asset.getParent()); Files.write(asset, new byte[]{1,2,3});
        }
        Files.writeString(vault.vaultPath().resolve("assets/not-a-note.md"), "附件不作为笔记");
        long cold = System.nanoTime(); NoteList listed = vault.list(); long coldMillis = (System.nanoTime() - cold) / 1_000_000;
        assertThat(listed.stats().notes()).isEqualTo(1200); assertThat(listed.stats().tags()).isEqualTo(60);
        assertThat(vault.cacheStats().contentReads()).isEqualTo(1200);
        assertThat(vault.cacheStats().graphBuilds()).isZero(); // List/get never create the tag clique.
        Graph firstGraph = vault.graph(); assertThat(firstGraph.edges()).hasSize(60 * 20 * 19 / 2);
        var before = vault.cacheStats(); long warm = System.nanoTime();
        for (int i = 0; i < 3; i++) {
            assertThat(vault.list().notes()).hasSize(1200);
            assertThat(vault.get("raw-50").id()).isEqualTo("raw-50");
            assertThat(vault.search("工程经验")).hasSize(50);
            assertThat(vault.graph()).isSameAs(firstGraph);
        }
        long warmMillis = (System.nanoTime() - warm) / 1_000_000;
        assertThat(vault.cacheStats()).isEqualTo(before);
        assertThat(warmMillis).isLessThan(10_000);
        System.out.println("Vault performance fixture: 1200 notes / 8000 assets; cold list=" + coldMillis + "ms, 12 warm operations=" + warmMillis + "ms; content reads=" + before.contentReads());
    }
}
