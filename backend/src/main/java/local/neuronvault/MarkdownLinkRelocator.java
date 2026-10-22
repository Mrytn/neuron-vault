package local.neuronvault;

import org.commonmark.node.*;
import org.commonmark.parser.IncludeSourceSpans;
import org.commonmark.parser.Parser;
import java.io.IOException;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.*;
import java.util.regex.Pattern;

/** Changes only Markdown destination slices; leaves all other source bytes untouched. */
final class MarkdownLinkRelocator {
    private static final Parser PARSER = Parser.builder().includeSourceSpans(IncludeSourceSpans.BLOCKS_AND_INLINES).build();
    private static final Pattern SCHEME = Pattern.compile("^[a-zA-Z][a-zA-Z0-9+.-]*:.*", Pattern.DOTALL);
    private record Slice(int start, int end) {}
    private record Edit(int start, int end, String value) {}
    private record Segment(String decoded, String source) {}
    private MarkdownLinkRelocator() {}

    static String relocate(String markdown, Path vault, Path oldFile, Path newFile) throws IOException {
        if (oldFile.equals(newFile)) return markdown;
        Node document = PARSER.parse(markdown);
        boolean[] code = new boolean[markdown.length()];
        document.accept(new AbstractVisitor() {
            @Override public void visit(Code node) { mask(node); }
            private void mask(Node node) {
                for (SourceSpan span : node.getSourceSpans()) Arrays.fill(code, span.getInputIndex(), span.getInputIndex() + span.getLength(), true);
            }
        });
        var frontmatter = Pattern.compile("\\A---\\R.*?\\R---(?:\\R|$)", Pattern.DOTALL).matcher(markdown);
        int frontmatterEnd = frontmatter.find() ? frontmatter.end() : 0;
        List<Edit> edits = new ArrayList<>();
        try {
            document.accept(new AbstractVisitor() {
                @Override public void visit(Link node) { inspect(node, node.getDestination(), false); visitChildren(node); }
                @Override public void visit(Image node) { inspect(node, node.getDestination(), false); visitChildren(node); }
                @Override public void visit(LinkReferenceDefinition node) { inspect(node, node.getDestination(), true); }
                private void inspect(Node node, String semantic, boolean definition) {
                    if (semantic.isBlank() || external(semantic)) return;
                    Slice bounds = sourceBounds(node);
                    if (bounds.start < frontmatterEnd) return;
                    Slice destination = destinationSlice(markdown, bounds, definition, code);
                    // Reference uses get their destination from a separately handled definition.
                    if (destination == null) return;
                    String raw = markdown.substring(destination.start, destination.end);
                    try {
                        String replacement = rebase(raw, semantic, vault, oldFile, newFile);
                        if (!replacement.equals(raw)) edits.add(new Edit(destination.start, destination.end, replacement));
                    } catch (IOException e) { throw new RelocationIo(e); }
                }
            });
        } catch (RelocationIo e) { throw e.cause; }
        edits.sort(Comparator.comparingInt(Edit::start).reversed());
        StringBuilder result = new StringBuilder(markdown);
        int previousStart = markdown.length() + 1;
        for (Edit edit : edits) {
            if (edit.end > previousStart) throw unsupported();
            result.replace(edit.start, edit.end, edit.value);
            previousStart = edit.start;
        }
        return result.toString();
    }
    private static class RelocationIo extends RuntimeException {
        final IOException cause;
        RelocationIo(IOException cause) { this.cause = cause; }
    }
    private static ApiException unsupported() {
        return ApiException.bad("无法安全重定位此 Markdown 相对链接，请先检查链接格式或改为知识库内的标准相对路径，再移动笔记。");
    }
    private static boolean external(String destination) {
        return destination.startsWith("/") || destination.startsWith("#") || destination.startsWith("?")
                || SCHEME.matcher(destination).matches();
    }
    private static Slice sourceBounds(Node node) {
        List<SourceSpan> spans = node.getSourceSpans();
        if (spans.isEmpty()) throw unsupported();
        return new Slice(spans.get(0).getInputIndex(), spans.get(spans.size() - 1).getInputIndex() + spans.get(spans.size() - 1).getLength());
    }
    private static Slice destinationSlice(String text, Slice bounds, boolean definition, boolean[] code) {
        int i = bounds.start;
        while (i < bounds.end && Character.isWhitespace(text.charAt(i))) i++;
        if (i < bounds.end && text.charAt(i) == '!') i++;
        if (i >= bounds.end || text.charAt(i) != '[') return null; // e.g. autolinks
        int depth = 0;
        for (; i < bounds.end; i++) {
            if (code[i]) continue;
            char c = text.charAt(i);
            if (c == '\\') { i++; continue; }
            if (c == '[') depth++;
            if (c == ']') { depth--; if (depth == 0) { i++; break; } }
        }
        if (i >= bounds.end) return null;
        if (definition) {
            if (text.charAt(i) != ':') throw unsupported();
            i++;
        } else {
            while (i < bounds.end && Character.isWhitespace(text.charAt(i))) i++;
            if (i >= bounds.end || text.charAt(i) != '(') return null;
            i++;
        }
        while (i < bounds.end && Character.isWhitespace(text.charAt(i))) i++;
        if (i >= bounds.end) throw unsupported();
        if (text.charAt(i) == '<') {
            int start = ++i;
            while (i < bounds.end) {
                if (text.charAt(i) == '\\') { i += 2; continue; }
                if (text.charAt(i) == '>') return new Slice(start, i);
                i++;
            }
            throw unsupported();
        }
        int start = i, parentheses = 0;
        for (; i < bounds.end; i++) {
            char c = text.charAt(i);
            if (c == '\\') { i++; continue; }
            if (Character.isWhitespace(c)) break;
            if (c == '(') parentheses++;
            if (c == ')') { if (parentheses == 0) break; parentheses--; }
        }
        if (parentheses != 0) throw unsupported();
        return new Slice(start, i);
    }
    private static String rebase(String raw, String semantic, Path vault, Path oldFile, Path newFile) throws IOException {
        int rawSuffix = suffixStart(raw), semanticSuffix = suffixStart(semantic);
        String rawPath = raw.substring(0, rawSuffix), suffix = raw.substring(rawSuffix);
        String semanticPath = semantic.substring(0, semanticSuffix);
        if (rawPath.isEmpty()) return raw;
        String[] rawSegments = rawPath.split("/", -1), semanticSegments = semanticPath.split("/", -1);
        if (rawSegments.length != semanticSegments.length) throw unsupported();
        List<Segment> target = new ArrayList<>();
        for (Path component : vault.relativize(oldFile.getParent())) {
            if (!component.toString().isEmpty()) target.add(new Segment(component.toString(), encode(component.toString())));
        }
        for (int i = 0; i < semanticSegments.length; i++) {
            String decoded;
            try { decoded = URLDecoder.decode(semanticSegments[i].replace("+", "%2B"), StandardCharsets.UTF_8); }
            catch (IllegalArgumentException e) { throw unsupported(); }
            if (decoded.indexOf('/') >= 0 || decoded.indexOf('\\') >= 0 || decoded.indexOf('\0') >= 0 || decoded.indexOf('\uFFFD') >= 0) throw unsupported();
            if (decoded.isEmpty() || decoded.equals(".")) continue;
            if (decoded.equals("..")) {
                if (target.isEmpty()) throw ApiException.bad("相对链接指向知识库之外，不能安全移动这篇笔记。");
                target.remove(target.size() - 1);
            } else target.add(new Segment(decoded, rawSegments[i]));
        }
        Path resolved = vault;
        for (Segment segment : target) resolved = resolved.resolve(segment.decoded);
        SafeFiles.rejectSymlinks(resolved);
        if (resolved.equals(oldFile)) {
            // Explicit self-links follow the note when its filename changes as well.
            String originalFilenameSource = target.isEmpty() ? null : target.get(target.size() - 1).source;
            boolean sameFilename = oldFile.getFileName().equals(newFile.getFileName());
            target.clear();
            for (Path segment : vault.relativize(newFile)) target.add(new Segment(segment.toString(), encode(segment.toString())));
            if (sameFilename && originalFilenameSource != null) {
                int last = target.size() - 1;
                target.set(last, new Segment(target.get(last).decoded, originalFilenameSource));
            }
        }
        List<String> origin = new ArrayList<>();
        for (Path segment : vault.relativize(newFile.getParent())) if (!segment.toString().isEmpty()) origin.add(segment.toString());
        int common = 0;
        while (common < origin.size() && common < target.size() && origin.get(common).equals(target.get(common).decoded)) common++;
        List<String> parts = new ArrayList<>();
        for (int i = common; i < origin.size(); i++) parts.add("..");
        for (int i = common; i < target.size(); i++) parts.add(target.get(i).source);
        String relocated = parts.isEmpty() ? "." : String.join("/", parts);
        if (rawPath.endsWith("/") && !relocated.endsWith("/")) relocated += "/";
        return relocated + suffix;
    }
    private static int suffixStart(String text) {
        int question = text.indexOf('?'), hash = text.indexOf('#');
        if (question < 0) return hash < 0 ? text.length() : hash;
        return hash < 0 ? question : Math.min(question, hash);
    }
    private static String encode(String segment) {
        return URLEncoder.encode(segment, StandardCharsets.UTF_8).replace("+", "%20").replace("%7E", "~");
    }
}
