package local.neuronvault;

import java.util.List;

public final class Models {
    private Models() {}
    public record NoteSummary(String id, String title, String path, String folder, List<String> tags,
                              String updatedAt, String excerpt, int wordCount, String sourceUrl, String sourceId, String sourceStatus, String sourceHtmlPath) {}
    public record Note(String id, String title, String path, String folder, List<String> tags,
                       String updatedAt, String excerpt, int wordCount, String sourceUrl, String sourceId, String sourceStatus, String sourceHtmlPath,
                       String content, String revision, List<NoteSummary> backlinks, List<NoteSummary> outgoing) {}
    public record NoteInput(String title, String folder, String content, String revision) {}
    public record ImportNote(String title, String folder, String content, String sourceUrl, String sourceId) {}
    public record ImportRequest(List<ImportNote> notes) {}
    public record ImportResult(int imported, int skipped, List<NoteSummary> notes) {}
    public record Stats(int notes, int links, int tags) {}
    public record NoteList(List<NoteSummary> notes, List<String> folders, Stats stats) {}
    public record SearchHit(String id, String title, String path, String excerpt, int line, double score, String sourceId, String sourceStatus) {}
    public record GraphNode(String id, String title, String group, List<String> tags) {}
    public record GraphEdge(String source, String target, String type, String label) {}
    public record Graph(List<GraphNode> nodes, List<GraphEdge> edges) {}
    public record Source(String id, String title, String path, String excerpt, int line) {}
    public record AskRequest(String question) {}
    public record AskResult(String mode, String answer, List<Source> sources, String warning) {}
    public record SettingsInput(String provider, String baseUrl, String model, String apiKey) {}
    public record SettingsView(String provider, String baseUrl, String model, boolean configured, String vaultPath) {}
}
