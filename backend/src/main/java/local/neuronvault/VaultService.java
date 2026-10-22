package local.neuronvault;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.commonmark.node.*;
import org.commonmark.parser.IncludeSourceSpans;
import org.commonmark.parser.Parser;

import java.io.*;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import java.util.regex.*;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import static local.neuronvault.Models.*;

@Service
public class VaultService {
    static final int MAX_CONTENT = 2_000_000;
    private static final Pattern INLINE_TAG = Pattern.compile("(?<![\\p{L}\\p{N}_/])#([\\p{L}\\p{N}_][\\p{L}\\p{N}_/-]*)");
    private static final Pattern WIKI = Pattern.compile("\\[\\[([^\\]|#]+)(?:#[^\\]|]+)?(?:\\|[^\\]]+)?\\]\\]");
    private static final Pattern PREVIEW_IMAGE = Pattern.compile("!\\[[^\\]]*]\\((?:<[^>]*>|[^)]*)\\)|!\\[[^\\]]*]\\[[^\\]]*]");
    private static final Pattern PREVIEW_LINK = Pattern.compile("\\[([^\\]]*)]\\((?:<[^>]*>|[^)]*)\\)");
    private static final Parser MARKDOWN_PARSER = Parser.builder().includeSourceSpans(IncludeSourceSpans.BLOCKS_AND_INLINES).build();
    final Path root;
    final Path vault;
    private final Path trash;
    private final Path index;
    private final ObjectMapper mapper;
    private final Map<String, Meta> metadata = new LinkedHashMap<>();

    private final Map<String, CacheEntry> fileCache = new HashMap<>();
    private Map<String, Stored> previousScan = Map.of();
    private List<GraphEdge> cachedLinks;
    private Graph cachedGraph;
    private long contentReads, linkBuilds, graphBuilds;

    public static class Meta {
        public String id, path, title, sourceUrl, sourceId, sourceStatus, fingerprint, lastHash, fileKey;
        public String sourceCreatedAt, sourceModifiedAt, sourceExportPath, sourceHtmlPath;
        public boolean deleted;
        public String deletedAt;
        public Meta() {}
    }
    private record Stored(Meta meta, Path file, String content, String revision, NoteSummary summary,
                          String[] lines, String[] lowerLines) {}
    private record FileStamp(long size, FileTime modified, FileTime changed, String key) {}
    private record MetaStamp(String id, String path, String title, String sourceUrl, String sourceId, String sourceStatus, String sourceHtmlPath) {
        static MetaStamp of(Meta m) { return new MetaStamp(m.id, m.path, m.title, m.sourceUrl, m.sourceId, m.sourceStatus, m.sourceHtmlPath); }
    }
    private record CacheEntry(FileStamp stamp, MetaStamp metaStamp, Stored stored) {}
    record CacheStats(long contentReads, long linkBuilds, long graphBuilds) {}
    synchronized CacheStats cacheStats() { return new CacheStats(contentReads, linkBuilds, graphBuilds); }

    @Autowired
    public VaultService(ObjectMapper mapper, @Value("${vault.home:${VAULT_HOME:}}") String configured) throws IOException {
        this(SafeFiles.resolveRoot(configured, Path.of(System.getProperty("user.dir"))), mapper);
    }
    public VaultService(Path root, ObjectMapper mapper) throws IOException {
        this.root = root.toAbsolutePath().normalize(); this.mapper = mapper;
        SafeFiles.privateDirectory(this.root);
        this.vault = this.root.resolve("vault"); this.trash = this.root.resolve(".trash");
        SafeFiles.privateDirectory(vault); SafeFiles.privateDirectory(trash);
        Path metaDir = this.root.resolve(".metadata"); SafeFiles.privateDirectory(metaDir);
        this.index = metaDir.resolve("index.json");
        SafeFiles.rejectSymlinks(index);
        if (Files.exists(index)) {
            for (Meta meta : mapper.readValue(Files.readAllBytes(index), new TypeReference<List<Meta>>() {})) {
                if (meta.id == null || !meta.id.matches("[a-zA-Z0-9-]{1,80}") || meta.path == null)
                    throw new IOException("知识库索引格式无效，请从备份恢复索引。");
                if (meta.sourceStatus != null && !Set.of("ok", "missing_body", "encrypted").contains(meta.sourceStatus))
                    throw new IOException("知识库索引包含未知的来源状态。");
                SafeFiles.beneath(vault, meta.path);
                metadata.put(meta.id, meta);
            }
        }
    }
    public Path vaultPath() { return vault; }
    private void persist() throws IOException { SafeFiles.writeAtomic(index, mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(metadata.values()), true); }
    static String sha(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (Exception e) { throw new IllegalStateException(e); }
    }
    private String relative(Path p) { return vault.relativize(p).toString().replace('\\', '/'); }
    private String read(Path file) throws IOException {
        SafeFiles.rejectSymlinks(file);
        if (Files.size(file) > MAX_CONTENT * 4L) throw ApiException.bad("笔记过大，请拆分为较小的 Markdown 文件。");
        contentReads++;
        return Files.readString(file, StandardCharsets.UTF_8);
    }
    private FileStamp stamp(Path file, BasicFileAttributes attrs) throws IOException {
        FileTime changed = null;
        // ctime catches same-size writes even when an editor restores the original mtime.
        // Filesystems without this signal safely fall back to rereading the content.
        try { changed = (FileTime) Files.getAttribute(file, "unix:ctime", LinkOption.NOFOLLOW_LINKS); }
        catch (UnsupportedOperationException | IllegalArgumentException ignored) { }
        return new FileStamp(attrs.size(), attrs.lastModifiedTime(), changed, Objects.toString(attrs.fileKey(), ""));
    }
    private Map<String, Stored> scan() throws IOException {
        SafeFiles.rejectSymlinks(vault);
        Map<Path, BasicFileAttributes> found = new TreeMap<>();
        Files.walkFileTree(vault, new SimpleFileVisitor<>() {
            @Override public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                if (!dir.equals(vault) && (dir.equals(vault.resolve("assets")) || !SafeFiles.exportable(vault.relativize(dir))))
                    return FileVisitResult.SKIP_SUBTREE;
                return FileVisitResult.CONTINUE;
            }
            @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                if (attrs.isRegularFile() && file.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".md")
                        && SafeFiles.exportable(vault.relativize(file))) found.put(file, attrs);
                return FileVisitResult.CONTINUE;
            }
        });
        Map<String, Meta> byPath = new HashMap<>();
        metadata.values().stream().filter(m -> !m.deleted).forEach(m -> byPath.put(m.path, m));
        Set<String> actualPaths = new HashSet<>(); found.keySet().forEach(p -> actualPaths.add(relative(p)));
        Map<String, List<Meta>> missingByKey = new HashMap<>(), missingByHash = new HashMap<>();
        for (Meta m : metadata.values()) if (!m.deleted && !actualPaths.contains(m.path)) {
            if (m.fileKey != null && !m.fileKey.isEmpty()) missingByKey.computeIfAbsent(m.fileKey, unused -> new ArrayList<>()).add(m);
            if (m.lastHash != null) missingByHash.computeIfAbsent(m.lastHash, unused -> new ArrayList<>()).add(m);
        }
        Map<String, Stored> result = new LinkedHashMap<>();
        boolean changed = false;
        for (var entry : found.entrySet()) {
            Path file = entry.getKey(); String rel = relative(file);
            FileStamp stamp = stamp(file, entry.getValue()); Meta meta = byPath.get(rel);
            CacheEntry cached = fileCache.get(rel);
            if (meta != null && cached != null && stamp.changed != null && stamp.equals(cached.stamp)
                    && MetaStamp.of(meta).equals(cached.metaStamp)) {
                result.put(meta.id, cached.stored); continue;
            }
            String content = read(file);
            FileStamp after = stamp(file, Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS));
            // Never cache text read while an external writer was changing its file.
            if (!stamp.equals(after)) {
                stamp = after; content = read(file);
                after = stamp(file, Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS));
                if (!stamp.equals(after)) throw new ApiException(409, "笔记正在被外部程序修改，请稍后刷新。");
            }
            String hash = sha(content), fileKey = stamp.key;
            if (meta == null) {
                Set<Meta> candidates = new LinkedHashSet<>(missingByKey.getOrDefault(fileKey, List.of()));
                candidates.addAll(missingByHash.getOrDefault(hash, List.of()));
                candidates.removeIf(m -> actualPaths.contains(m.path) || result.containsKey(m.id));
                if (candidates.size() == 1) meta = candidates.iterator().next();
                else { meta = new Meta(); meta.id = UUID.randomUUID().toString(); metadata.put(meta.id, meta); }
                meta.path = rel; changed = true;
            }
            if (!hash.equals(meta.lastHash) || !fileKey.equals(meta.fileKey)) {
                meta.lastHash = hash; meta.fileKey = fileKey; changed = true;
            }
            String[] lines = content.split("\\R", -1);
            Stored stored = new Stored(meta, file, content, hash, summary(meta, file, content), lines,
                    Arrays.stream(lines).map(line -> line.toLowerCase(Locale.ROOT)).toArray(String[]::new));
            fileCache.put(rel, new CacheEntry(stamp, MetaStamp.of(meta), stored)); result.put(meta.id, stored);
        }
        fileCache.keySet().retainAll(actualPaths);
        if (result.size() != previousScan.size() || result.entrySet().stream().anyMatch(e -> previousScan.get(e.getKey()) != e.getValue())) {
            cachedLinks = null; cachedGraph = null;
        }
        previousScan = result;
        if (changed) persist();
        return result;
    }
    private NoteSummary summary(Meta m, Path file, String content) throws IOException {
        String title = m.title == null || m.title.isBlank() ? deriveTitle(content, Path.of(m.path).getFileName().toString()) : m.title;
        String folder = m.path.contains("/") ? m.path.substring(0, m.path.lastIndexOf('/')) : "";
        String excerpt = noteExcerpt(content);
        Matcher words = Pattern.compile("\\p{IsHan}|[\\p{L}\\p{N}_]+").matcher(content);
        int wordCount = 0; while (words.find()) wordCount++;
        return new NoteSummary(m.id, title, m.path, folder, tags(content), Files.getLastModifiedTime(file, LinkOption.NOFOLLOW_LINKS).toInstant().toString(), excerpt, wordCount, m.sourceUrl, m.sourceId, m.sourceStatus, m.sourceHtmlPath);
    }
    static String noteExcerpt(String content) {
        String body = content.replaceAll("(?s)^---\\R.*?\\R---(?:\\R|$)", "");
        Matcher images = PREVIEW_IMAGE.matcher(prose(body));
        int imageCount = 0;
        while (images.find()) imageCount++;
        String visible = PREVIEW_IMAGE.matcher(body).replaceAll("");
        String headingFallback = "";
        StringBuilder paragraph = new StringBuilder();
        for (String rawLine : visible.split("\\R", -1)) {
            String line = rawLine.strip();
            if (line.isBlank()) {
                if (!paragraph.isEmpty()) return trimTo(paragraph.toString(), 180);
                continue;
            }
            if (line.matches("^(?:```|~~~).*") || line.matches("^\\[[^]]+]:\\s+.*")) continue;
            // Keep labels in prose links, but omit lines consisting only of links or URLs.
            String withoutLinks = PREVIEW_LINK.matcher(line).replaceAll("")
                    .replaceAll("<?https?://[^\\s>]+>?", "").strip();
            if (withoutLinks.matches("[\\s,;:|·•—，；：-]*")) continue;
            line = PREVIEW_LINK.matcher(line).replaceAll("$1").replaceAll("<?https?://[^\\s>]+>?", "")
                    .replaceAll("\\\\([\\\\`*_\\[\\]<>])", "$1").strip();
            if (line.matches("^#{1,6}\\s+.*")) {
                if (headingFallback.isBlank()) headingFallback = line.replaceFirst("^#{1,6}\\s+", "");
                continue;
            }
            line = line.replaceFirst("^(?:>\\s*|[-*+]\\s+|\\d+[.)]\\s+)", "")
                    .replaceAll("[*_`~]{1,3}", "").replaceAll("\\s+", " ").strip();
            if (!line.isBlank()) {
                if (!paragraph.isEmpty()) paragraph.append(' ');
                paragraph.append(line);
                if (paragraph.length() >= 180) return trimTo(paragraph.toString(), 180);
            }
        }
        if (!paragraph.isEmpty()) return trimTo(paragraph.toString(), 180);
        if (imageCount > 0) return "图片笔记 · " + imageCount + " 张图片";
        return trimTo(headingFallback, 180);
    }
    private static String deriveTitle(String content, String filename) {
        Matcher fm = Pattern.compile("(?m)^title:\\s*['\"]?([^\\r\\n]+)").matcher(frontmatter(content));
        if (fm.find()) return fm.group(1).replaceAll("['\"]$", "").strip();
        Matcher heading = Pattern.compile("(?m)^#\\s+(.+)$").matcher(content);
        return heading.find() ? heading.group(1).strip() : filename.replaceFirst("(?i)\\.md$", "");
    }
    private static String frontmatter(String content) {
        Matcher m = Pattern.compile("\\A---\\R(.*?)\\R---(?:\\R|$)", Pattern.DOTALL).matcher(content);
        return m.find() ? m.group(1) : "";
    }
    private static String prose(String content) {
        char[] visible = content.toCharArray();
        MARKDOWN_PARSER.parse(content).accept(new AbstractVisitor() {
            @Override public void visit(Code node) { mask(node); }
            @Override public void visit(FencedCodeBlock node) { mask(node); }
            @Override public void visit(IndentedCodeBlock node) { mask(node); }
            @Override public void visit(HtmlBlock node) { mask(node); }
            @Override public void visit(HtmlInline node) { mask(node); }
            private void mask(Node node) {
                for (SourceSpan span : node.getSourceSpans()) {
                    for (int i = span.getInputIndex(); i < span.getInputIndex() + span.getLength(); i++)
                        if (visible[i] != '\n' && visible[i] != '\r') visible[i] = ' ';
                }
            }
        });
        return new String(visible);
    }
    static List<String> tags(String content) {
        Set<String> tags = new TreeSet<>();
        Matcher inline = INLINE_TAG.matcher(prose(content.replaceFirst("(?s)\\A---\\R.*?\\R---(?:\\R|$)", ""))); while (inline.find()) tags.add(inline.group(1));
        String[] lines = frontmatter(content).split("\\R"); boolean list = false;
        for (String line : lines) {
            if (line.matches("^tags\\s*:.*")) {
                String value = line.substring(line.indexOf(':') + 1).strip();
                list = value.isEmpty();
                if (!value.isEmpty()) for (String tag : value.replaceAll("^\\[|\\]$", "").split(",")) addTag(tags, tag);
            } else if (list && line.matches("^\\s*-\\s+.+")) addTag(tags, line.replaceFirst("^\\s*-\\s+", ""));
            else if (!line.isBlank()) list = false;
        }
        return List.copyOf(tags);
    }
    private static void addTag(Set<String> tags, String value) {
        String tag = value.strip().replaceAll("^['\"]|['\"]$", "").replaceFirst("^#", "");
        if (!tag.isBlank() && tag.length() <= 100) tags.add(tag);
    }
    public synchronized NoteList list() throws IOException {
        Map<String, Stored> all = scan();
        List<NoteSummary> notes = all.values().stream().map(Stored::summary)
                .sorted(Comparator.comparing(NoteSummary::updatedAt).reversed()).toList();
        Set<String> folders = new TreeSet<>(), tags = new TreeSet<>();
        for (NoteSummary n : notes) { folders.add(n.folder()); tags.addAll(n.tags()); }
        int links = links(all).size();
        return new NoteList(notes, List.copyOf(folders), new Stats(notes.size(), links, tags.size()));
    }
    public synchronized Note get(String id) throws IOException {
        Map<String, Stored> all = scan();
        return full(require(all, id), all);
    }
    private Stored require(Map<String, Stored> all, String id) {
        Stored stored = all.get(id); if (stored == null) throw new ApiException(404, "未找到这篇笔记。"); return stored;
    }
    private Note full(Stored stored, Map<String, Stored> all) {
        List<GraphEdge> edges = links(all);
        Set<String> in = new LinkedHashSet<>(), out = new LinkedHashSet<>();
        for (GraphEdge edge : edges) if (edge.type().equals("link")) {
            if (edge.source().equals(stored.meta.id)) out.add(edge.target());
            if (edge.target().equals(stored.meta.id)) in.add(edge.source());
        }
        NoteSummary s = stored.summary;
        return new Note(s.id(), s.title(), s.path(), s.folder(), s.tags(), s.updatedAt(), s.excerpt(), s.wordCount(), s.sourceUrl(), s.sourceId(), s.sourceStatus(), s.sourceHtmlPath(), stored.content, stored.revision,
                in.stream().map(all::get).map(Stored::summary).toList(), out.stream().map(all::get).map(Stored::summary).toList());
    }
    private static String title(String title) {
        if (title == null || title.isBlank()) throw ApiException.bad("标题不能为空。");
        if (title.length() > 200 || title.chars().anyMatch(Character::isISOControl)) throw ApiException.bad("标题过长或包含控制字符。");
        return title.strip();
    }
    private String folder(String folder) throws IOException {
        String normalized = folder == null ? "" : folder.strip();
        if (normalized.length() > 500) throw ApiException.bad("目录过长。");
        Path p = SafeFiles.beneath(vault, normalized);
        for (Path part : vault.relativize(p)) if (part.toString().startsWith(".")) throw ApiException.bad("不允许隐藏目录。");
        return vault.relativize(p).toString().replace('\\', '/');
    }
    private static String content(String content) {
        if (content == null) throw ApiException.bad("缺少 Markdown 内容。");
        if (content.length() > MAX_CONTENT || content.indexOf('\0') >= 0) throw ApiException.bad("笔记过大或含无效字符。");
        return content;
    }
    private Path uniquePath(String folder, String title, Path current) throws IOException {
        String filename = trimTo(title.replaceAll("[<>:\"/\\\\|?*\\p{Cntrl}]", "-").replaceAll("^[. ]+|[. ]+$", ""), 90);
        if (filename.isBlank()) filename = "未命名";
        // Filesystem limits are bytes, so 90 Chinese characters can exceed NAME_MAX.
        while (filename.getBytes(StandardCharsets.UTF_8).length > 180)
            filename = filename.substring(0, filename.offsetByCodePoints(filename.length(), -1));
        for (int i = 0; i < 10000; i++) {
            String suffix = i == 0 ? "" : "-" + (i + 1);
            Path candidate = SafeFiles.beneath(vault, (folder.isEmpty() ? "" : folder + "/") + filename + suffix + ".md");
            if (candidate.equals(current) || !Files.exists(candidate, LinkOption.NOFOLLOW_LINKS)) return candidate;
        }
        throw ApiException.bad("同名笔记过多，请更换标题。");
    }
    public synchronized Note create(NoteInput input) throws IOException {
        if (input == null) throw ApiException.bad("缺少笔记内容。");
        Meta meta = createFile(input.title(), input.folder(), input.content(), null, null, null);
        return get(meta.id);
    }
    private Meta createFile(String rawTitle, String rawFolder, String rawContent, String sourceUrl, String sourceId, String fingerprint) throws IOException {
        String title = title(rawTitle), folder = folder(rawFolder), content = content(rawContent);
        Path file = uniquePath(folder, title, null);
        Meta meta = new Meta(); meta.id = UUID.randomUUID().toString(); meta.path = relative(file); meta.title = title;
        meta.sourceUrl = sourceUrl; meta.sourceId = sourceId; meta.sourceStatus = sourceId == null ? null : "ok"; meta.fingerprint = fingerprint;
        SafeFiles.writeAtomic(file, content.getBytes(StandardCharsets.UTF_8), false);
        metadata.put(meta.id, meta); persist(); return meta;
    }
    public synchronized Note update(String id, NoteInput input) throws IOException {
        Stored current = require(scan(), id);
        if (input == null || input.revision() == null || !input.revision().equals(current.revision))
            throw new ApiException(409, "笔记已被其他编辑器修改，请重新加载后再保存。");
        String title = title(input.title()), folder = folder(input.folder()), text = content(input.content());
        Path next = current.summary.title().equals(title) && current.summary.folder().equals(folder)
                ? current.file : uniquePath(folder, title, current.file);
        if (!next.equals(current.file)) text = MarkdownLinkRelocator.relocate(text, vault, current.file, next);
        // Recheck immediately before writing, including edits made since the scan.
        if (!sha(read(current.file)).equals(input.revision())) throw new ApiException(409, "笔记已变化，请重新加载。");
        SafeFiles.writeAtomic(next, text.getBytes(StandardCharsets.UTF_8), false);
        if (!next.equals(current.file)) { SafeFiles.rejectSymlinks(current.file); Files.delete(current.file); }
        current.meta.path = relative(next); current.meta.title = title; persist();
        return get(id);
    }
    public synchronized void delete(String id) throws IOException {
        Stored current = require(scan(), id);
        Path target = SafeFiles.beneath(trash, id + ".md");
        SafeFiles.rejectSymlinks(current.file); Files.move(current.file, target);
        current.meta.deleted = true; current.meta.deletedAt = Instant.now().toString(); persist();
    }
    public synchronized List<NoteSummary> trash() throws IOException {
        List<NoteSummary> notes = new ArrayList<>();
        for (Meta meta : metadata.values()) if (meta.deleted) {
            Path file = SafeFiles.beneath(trash, meta.id + ".md");
            if (Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) notes.add(summary(meta, file, read(file)));
        }
        return notes;
    }
    public synchronized Note restore(String id) throws IOException {
        Meta meta = metadata.get(id);
        if (meta == null || !meta.deleted) throw new ApiException(404, "回收站中没有这篇笔记。");
        Path source = SafeFiles.beneath(trash, id + ".md");
        if (!Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS)) throw new ApiException(404, "回收文件不存在。");
        Path target = SafeFiles.beneath(vault, meta.path);
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            String f = meta.path.contains("/") ? meta.path.substring(0, meta.path.lastIndexOf('/')) : "";
            target = uniquePath(f, meta.title == null ? deriveTitle(read(source), source.getFileName().toString()) : meta.title, null);
        }
        Files.createDirectories(target.getParent()); SafeFiles.rejectSymlinks(target);
        Files.move(source, target); meta.path = relative(target); meta.deleted = false; meta.deletedAt = null; persist();
        return get(id);
    }
    public synchronized ImportResult importNotes(ImportRequest request) throws IOException {
        if (request == null || request.notes() == null || request.notes().size() > 1000) throw ApiException.bad("一次最多导入 1000 篇笔记。");
        long total = 0;
        for (ImportNote note : request.notes()) {
            if (note == null) throw ApiException.bad("导入记录不能为空。");
            title(note.title()); folder(note.folder()); total += content(note.content()).length();
            if (total > 15_000_000) throw ApiException.bad("一次导入内容过大，请分批导入。");
            if (note.sourceUrl() != null && note.sourceUrl().length() > 4000) throw ApiException.bad("来源 URL 过长。");
            if (note.sourceId() != null && note.sourceId().length() > 1000) throw ApiException.bad("来源 ID 过长。");
        }
        scan(); Set<String> known = new HashSet<>(); metadata.values().forEach(m -> { if (m.fingerprint != null) known.add(m.fingerprint); });
        List<String> added = new ArrayList<>(); int skipped = 0;
        for (ImportNote note : request.notes()) {
            String source = note.sourceId() != null && !note.sourceId().isBlank() ? "id:" + note.sourceId()
                    : note.sourceUrl() != null && !note.sourceUrl().isBlank() ? "url:" + note.sourceUrl()
                    : "file:" + folder(note.folder()) + "/" + title(note.title());
            String fingerprint = sha(source + "\n" + sha(note.content()));
            if (!known.add(fingerprint)) { skipped++; continue; }
            Meta meta = createFile(note.title(), note.folder(), note.content(), note.sourceUrl(), note.sourceId(), fingerprint); added.add(meta.id);
        }
        Map<String, Stored> all = scan();
        return new ImportResult(added.size(), skipped, added.stream().map(all::get).map(Stored::summary).toList());
    }
    public synchronized Graph graph() throws IOException { return graph(scan()); }
    private List<GraphEdge> links(Map<String, Stored> all) {
        if (cachedLinks != null) return cachedLinks;
        linkBuilds++;
        Map<String, Stored> byPath = new HashMap<>(), uniqueTitles = new HashMap<>();
        Set<String> ambiguousTitles = new HashSet<>();
        for (Stored s : all.values()) {
            byPath.put(s.meta.path, s);
            String title = s.summary.title();
            if (uniqueTitles.putIfAbsent(title, s) != null) ambiguousTitles.add(title);
        }
        ambiguousTitles.forEach(uniqueTitles::remove);
        Map<String, GraphEdge> edges = new LinkedHashMap<>();
        for (Stored s : all.values()) {
            String text = prose(s.content); Matcher wiki = WIKI.matcher(text);
            while (wiki.find()) addLink(edges, s, resolve(s, wiki.group(1), true, byPath, uniqueTitles));
            // Parsed destinations cover inline and reference links; code examples are never visited.
            MARKDOWN_PARSER.parse(s.content).accept(new AbstractVisitor() {
                @Override public void visit(Link node) {
                    addLink(edges, s, resolve(s, node.getDestination(), false, byPath, uniqueTitles));
                    visitChildren(node);
                }
            });
        }
        cachedLinks = List.copyOf(edges.values()); return cachedLinks;
    }
    private Graph graph(Map<String, Stored> all) {
        if (cachedGraph != null) return cachedGraph;
        graphBuilds++;
        List<GraphNode> nodes = all.values().stream().map(s -> new GraphNode(s.meta.id, s.summary.title(), s.summary.folder(), s.summary.tags())).toList();
        Map<String, GraphEdge> edges = new LinkedHashMap<>();
        for (GraphEdge edge : links(all)) edges.put("link:" + edge.source() + ":" + edge.target(), edge);
        Map<String, List<String>> byTag = new TreeMap<>();
        for (Stored s : all.values()) for (String tag : s.summary.tags()) byTag.computeIfAbsent(tag, unused -> new ArrayList<>()).add(s.meta.id);
        for (var entry : byTag.entrySet()) {
            List<String> ids = entry.getValue();
            for (int i = 0; i < ids.size(); i++) for (int j = i + 1; j < ids.size(); j++) {
                GraphEdge edge = new GraphEdge(ids.get(i), ids.get(j), "tag", entry.getKey());
                edges.put("tag:" + edge.source() + ":" + edge.target() + ":" + edge.label(), edge);
            }
        }
        cachedGraph = new Graph(nodes, List.copyOf(edges.values())); return cachedGraph;
    }
    private static void addLink(Map<String, GraphEdge> edges, Stored source, Stored target) {
        if (target != null && !source.meta.id.equals(target.meta.id)) {
            GraphEdge edge = new GraphEdge(source.meta.id, target.meta.id, "link", "笔记链接");
            edges.put("link:" + edge.source() + ":" + edge.target(), edge);
        }
    }
    private Stored resolve(Stored from, String raw, boolean wiki, Map<String, Stored> byPath, Map<String, Stored> uniqueTitles) {
        String value;
        try { value = URLDecoder.decode(raw.strip().replace("+", "%2B"), StandardCharsets.UTF_8); }
        catch (IllegalArgumentException e) { return null; }
        if (value.matches("^[a-zA-Z][a-zA-Z0-9+.-]*:.*") || value.startsWith("//") || value.startsWith("#") || value.contains("\\")) return null;
        value = value.split("[?#]", 2)[0]; if (value.isBlank()) return null;
        String target = value;
        if (!target.toLowerCase(Locale.ROOT).endsWith(".md")) {
            if (!wiki) return null;
            target += ".md";
        }
        try {
            Path rel = Path.of(from.meta.path).getParent();
            Path resolved = (rel == null ? Path.of(target) : rel.resolve(target)).normalize();
            if (!resolved.isAbsolute() && !resolved.startsWith("..")) {
                String match = resolved.toString().replace('\\', '/');
                Stored candidate = byPath.get(match); if (candidate != null) return candidate;
            }
            if (wiki) {
                String match = target;
                Stored candidate = byPath.get(match); if (candidate != null) return candidate;
                String title = value.replaceFirst("(?i)\\.md$", "");
                return uniqueTitles.get(title);
            }
        } catch (InvalidPathException ignored) { }
        return null;
    }
    static List<String> queryTerms(String query) {
        String normalized = query.toLowerCase(Locale.ROOT).strip(); Set<String> terms = new LinkedHashSet<>();
        Matcher latin = Pattern.compile("[a-z0-9_]+|[\\p{IsHan}]+").matcher(normalized);
        while (latin.find()) {
            String term = latin.group();
            if (term.matches("[a-z0-9_]+")) { if (term.length() > 1) terms.add(term); }
            else {
                term = term.replaceAll("请问|如何|什么|为什么|怎么|可以|帮我|一下|是否", " ");
                for (String part : term.split("\\s+")) {
                    if (part.length() >= 2) { terms.add(part); for (int i = 0; i + 1 < part.length(); i++) terms.add(part.substring(i, i + 2)); }
                    else if (part.length() == 1 && normalized.length() == 1) terms.add(part);
                }
            }
        }
        return List.copyOf(terms);
    }
    public synchronized List<SearchHit> search(String query) throws IOException { return search(query, false); }
    synchronized List<SearchHit> searchEvidence(String query) throws IOException { return search(query, true); }
    private List<SearchHit> search(String query, boolean evidenceOnly) throws IOException {
        if (query == null || query.isBlank()) return List.of();
        if (query.length() > 2000) throw ApiException.bad("搜索词过长。");
        List<String> terms = queryTerms(query); if (terms.isEmpty()) return List.of();
        List<SearchHit> results = new ArrayList<>();
        for (Stored note : scan().values()) {
            if (evidenceOnly && note.meta.sourceStatus != null && !note.meta.sourceStatus.equals("ok")) continue;
            double titleScore = score(note.summary.title(), terms) * 2;
            String[] lines = note.lines;
            double best = 0; int bestLine = 0;
            for (int i = 0; i < lines.length; i++) {
                double current = scoreLower(note.lowerLines[i], terms);
                if (current > best) { best = current; bestLine = i; }
            }
            if (best + titleScore > 0) {
                String line = lines[bestLine]; int matchAt = firstMatch(line, terms);
                int start = Math.max(0, matchAt - 100), end = Math.min(line.length(), start + 480);
                String excerpt = (start > 0 ? "…" : "") + line.substring(start, end) + (end < line.length() ? "…" : "");
                if (excerpt.isBlank()) excerpt = trimTo(note.content, 480);
                results.add(new SearchHit(note.meta.id, note.summary.title(), note.meta.path, excerpt, bestLine + 1, best + titleScore, note.meta.sourceId, note.meta.sourceStatus));
            }
        }
        return results.stream().sorted(Comparator.comparingDouble(SearchHit::score).reversed().thenComparing(SearchHit::title)).limit(50).toList();
    }
    private static int firstMatch(String line, List<String> terms) {
        String lower = line.toLowerCase(Locale.ROOT); int best = Integer.MAX_VALUE;
        for (String term : terms) { int at = lower.indexOf(term); if (at >= 0) best = Math.min(best, at); }
        return best == Integer.MAX_VALUE ? 0 : best;
    }
    private static double score(String line, List<String> terms) {
        return scoreLower(line.toLowerCase(Locale.ROOT), terms);
    }
    private static double scoreLower(String lower, List<String> terms) {
        double score = 0;
        for (String term : terms) if (lower.contains(term)) score += Math.min(term.length(), 12);
        return score;
    }
    static String trimTo(String text, int max) { return text.length() > max ? text.substring(0, max) : text; }
    public synchronized byte[] exportZip() throws IOException {
        SafeFiles.rejectSymlinks(vault);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes, StandardCharsets.UTF_8); Stream<Path> stream = Files.walk(vault)) {
            for (Path path : stream.filter(p -> Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS)).sorted().toList()) {
                Path rel = vault.relativize(path); if (!SafeFiles.exportable(rel)) continue;
                SafeFiles.rejectSymlinks(path);
                zip.putNextEntry(new ZipEntry(rel.toString().replace('\\', '/'))); Files.copy(path, zip); zip.closeEntry();
            }
        }
        return bytes.toByteArray();
    }
}
