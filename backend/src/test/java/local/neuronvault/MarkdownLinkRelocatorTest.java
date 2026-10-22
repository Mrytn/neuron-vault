package local.neuronvault;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import static org.assertj.core.api.Assertions.*;
import static local.neuronvault.Models.*;

class MarkdownLinkRelocatorTest {
    @TempDir Path temp;
    VaultService vault;
    @BeforeEach void setup() throws Exception {
        vault = new VaultService(temp.resolve("data"), new ObjectMapper());
        Files.createDirectories(vault.vaultPath().resolve("assets/youdao/source"));
        Files.writeString(vault.vaultPath().resolve("assets/youdao/source/图 one(1).png"), "image fixture");
        Files.writeString(vault.vaultPath().resolve("assets/youdao/source/手册.pdf"), "attachment fixture");
        Files.createDirectories(vault.vaultPath().resolve("有道/AI"));
        Files.writeString(vault.vaultPath().resolve("有道/AI/目标 笔记.md"), "目标正文");
    }
    @Test void deeperAndShallowerMovesKeepRealImageAttachmentAndNoteTargets() throws Exception {
        String encoded = "%E5%9B%BE%20one(1).png";
        String raw = "正文前缀\n\n![图片](<../../assets/youdao/source/" + encoded + "?download=1#原锚点> \"图片标题\")\n"
                + "[附件](../../assets/youdao/source/%E6%89%8B%E5%86%8C.pdf#page=2)\n"
                + "[笔记](<目标%20笔记.md?mode=read#段落>)\n正文后缀\n";
        Note original = vault.create(new NoteInput("移动笔记", "有道/AI", raw, null));
        Note deep = vault.update(original.id(), new NoteInput(original.title(), "个人/知识/更深/AI", raw, original.revision()));
        assertThat(deep.content()).contains("../../../../assets/youdao/source/" + encoded + "?download=1#原锚点")
                .contains("../../../../%E6%9C%89%E9%81%93/AI/目标%20笔记.md?mode=read#段落");
        assertResolves(deep, "../../../../assets/youdao/source/" + encoded, "assets/youdao/source/图 one(1).png");
        assertResolves(deep, "../../../../%E6%9C%89%E9%81%93/AI/目标%20笔记.md", "有道/AI/目标 笔记.md");
        Note shallow = vault.update(deep.id(), new NoteInput(deep.title(), "", deep.content(), deep.revision()));
        assertThat(shallow.content()).contains("assets/youdao/source/" + encoded + "?download=1#原锚点")
                .contains("assets/youdao/source/%E6%89%8B%E5%86%8C.pdf#page=2")
                .contains("%E6%9C%89%E9%81%93/AI/目标%20笔记.md?mode=read#段落")
                .startsWith("正文前缀\n\n").endsWith("正文后缀\n");
        assertResolves(shallow, "assets/youdao/source/" + encoded, "assets/youdao/source/图 one(1).png");
        assertThat(shallow.id()).isEqualTo(original.id());
        assertThat(shallow.outgoing()).extracting(NoteSummary::path).contains("有道/AI/目标 笔记.md");
    }
    @Test void codeSamplesExternalAbsoluteAnchorsAndWikilinksStayByteForByte() throws Exception {
        String untouched = "[web](https://example.com/a?x=1#anchor)\n[mail](mailto:a@example.com)\n"
                + "[absolute](/assets/a.png)\n[anchor](#本段)\n[[目标 笔记]]\n"
                + "`![inline](../../assets/youdao/source/test.png)`\n\n"
                + "````markdown\n![code](../../assets/code.png)\n[code-ref]: ../../assets/code.png\n````\n\n"
                + "    ![indented](../../assets/indented.png)\n\n"
                + "> ~~~md\n> [quoted-code](../../assets/q.png)\n> ~~~\n";
        String output = MarkdownLinkRelocator.relocate(untouched, vault.vaultPath(), vault.vaultPath().resolve("有道/AI/old.md"), vault.vaultPath().resolve("new.md"));
        assertThat(output).isEqualTo(untouched);
    }
    @Test void referenceDefinitionsAndNestedImageLinksAreRebasedWithoutChangingLabels() throws Exception {
        String raw = "![原图][image]\n[笔记][note]\n[快捷]\n\n"
                + "[image]: <../../assets/youdao/source/%E5%9B%BE%20one(1).png?x=1&amp;y=2#fig> \"保留标题\"\n"
                + "[note]: 目标%20笔记.md \"原来的标题\"\n"
                + "[快捷]:\n  ../../assets/youdao/source/%E6%89%8B%E5%86%8C.pdf#page=1\n"
                + "\n[![嵌套](<../../assets/youdao/source/%E5%9B%BE%20one(1).png>)](目标%20笔记.md)\n";
        String output = MarkdownLinkRelocator.relocate(raw, vault.vaultPath(), vault.vaultPath().resolve("有道/AI/old.md"), vault.vaultPath().resolve("new.md"));
        assertThat(output).contains("[image]: <assets/youdao/source/%E5%9B%BE%20one(1).png?x=1&amp;y=2#fig> \"保留标题\"")
                .contains("[note]: %E6%9C%89%E9%81%93/AI/目标%20笔记.md \"原来的标题\"")
                .contains("[快捷]:\n  assets/youdao/source/%E6%89%8B%E5%86%8C.pdf#page=1")
                .contains("[![嵌套](<assets/youdao/source/%E5%9B%BE%20one(1).png>)](%E6%9C%89%E9%81%93/AI/目标%20笔记.md)");
    }
    @Test void unsafeRelativeTargetsRejectMoveBeforeChangingAnyFile() throws Exception {
        for (String target : new String[]{"../../../outside.txt", "../../assets/a%2Fb.png", "../../assets/bad%GG.png"}) {
            Note note = vault.create(new NoteInput("危险链接", "有道/AI", "[相对链接](" + target + ")", null));
            assertThatThrownBy(() -> vault.update(note.id(), new NoteInput(note.title(), "elsewhere", note.content(), note.revision())))
                    .isInstanceOf(ApiException.class);
            assertThat(vault.get(note.id()).path()).isEqualTo(note.path());
            assertThat(Files.readString(vault.vaultPath().resolve(note.path()))).isEqualTo(note.content());
        }
    }
    @Test void symlinkTargetRejectsMoveAndSelfLinkFollowsRename() throws Exception {
        Path outside = temp.resolve("outside.txt"); Files.writeString(outside, "private");
        Files.createSymbolicLink(vault.vaultPath().resolve("assets/alias.txt"), outside);
        assertThatThrownBy(() -> MarkdownLinkRelocator.relocate("[link](../../assets/alias.txt)", vault.vaultPath(), vault.vaultPath().resolve("有道/AI/a.md"), vault.vaultPath().resolve("a.md")))
                .isInstanceOf(ApiException.class);
        String result = MarkdownLinkRelocator.relocate("[self](old.md#section)", vault.vaultPath(), vault.vaultPath().resolve("有道/AI/old.md"), vault.vaultPath().resolve("new-folder/new.md"));
        assertThat(result).isEqualTo("[self](new.md#section)");
    }
    @Test void movingSelfLinkPreservesItsExistingPercentEncodingExactly() throws Exception {
        String raw = "[本篇](%e7%ac%94%e8%ae%b0.md?view=1#原锚点)";
        String moved = MarkdownLinkRelocator.relocate(raw, vault.vaultPath(), vault.vaultPath().resolve("有道/AI/笔记.md"), vault.vaultPath().resolve("笔记.md"));
        assertThat(moved).isEqualTo(raw);
    }
    private void assertResolves(Note note, String url, String expected) {
        String decoded = URLDecoder.decode(url.replace("+", "%2B"), StandardCharsets.UTF_8);
        Path target = vault.vaultPath().resolve(note.path()).getParent().resolve(decoded).normalize();
        assertThat(target).isEqualTo(vault.vaultPath().resolve(expected));
        assertThat(target).exists();
    }
}
