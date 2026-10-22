package local.neuronvault;

import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import java.io.IOException;
import java.util.Map;
import static local.neuronvault.Models.*;

@RestController
@RequestMapping("/api")
public class ApiController {
    private final VaultService vault;
    private final SettingsService settings;
    private final AiService ai;
    private final AssetService assets;
    public ApiController(VaultService vault, SettingsService settings, AiService ai) { this.vault = vault; this.settings = settings; this.ai = ai; this.assets = new AssetService(vault); }
    @GetMapping("/assets/{*assetPath}") public ResponseEntity<byte[]> asset(@PathVariable String assetPath) throws IOException {
        AssetService.Asset asset = assets.get(assetPath);
        ContentDisposition disposition = (asset.inline() ? ContentDisposition.inline() : ContentDisposition.attachment())
                .filename(asset.filename(), java.nio.charset.StandardCharsets.UTF_8).build();
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(asset.mediaType()))
                .header(HttpHeaders.CONTENT_DISPOSITION, disposition.toString())
                .header("Content-Security-Policy", "default-src 'none'; sandbox")
                .body(asset.bytes());
    }
    @GetMapping("/health") public Map<String, String> health() { return Map.of("status", "ok"); }
    @GetMapping("/notes") public NoteList list() throws IOException { return vault.list(); }
    @GetMapping("/notes/{id}") public Note get(@PathVariable String id) throws IOException { return vault.get(id); }
    @PostMapping("/notes") public Note create(@RequestBody NoteInput input) throws IOException { return vault.create(input); }
    @PutMapping("/notes/{id}") public Note update(@PathVariable String id, @RequestBody NoteInput input) throws IOException { return vault.update(id, input); }
    @DeleteMapping("/notes/{id}") public Map<String, Boolean> delete(@PathVariable String id) throws IOException { vault.delete(id); return Map.of("ok", true); }
    @GetMapping("/trash") public Map<String, ?> trash() throws IOException { return Map.of("notes", vault.trash()); }
    @PostMapping("/trash/{id}/restore") public Note restore(@PathVariable String id) throws IOException { return vault.restore(id); }
    @GetMapping("/search") public Map<String, ?> search(@RequestParam(defaultValue = "") String q) throws IOException { return Map.of("results", vault.search(q)); }
    @GetMapping("/graph") public Graph graph() throws IOException { return vault.graph(); }
    @PostMapping("/ask") public AskResult ask(@RequestBody AskRequest request) throws IOException { return ai.ask(request.question()); }
    @GetMapping("/settings") public SettingsView settings() throws IOException { return settings.get(); }
    @PutMapping("/settings") public SettingsView settings(@RequestBody SettingsInput input) throws IOException { return settings.update(input); }
    @PostMapping("/import") public ImportResult imports(@RequestBody ImportRequest request) throws IOException { return vault.importNotes(request); }
    @GetMapping("/export") public ResponseEntity<byte[]> export() throws IOException {
        return ResponseEntity.ok().header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=neuron-vault.zip")
                .contentType(MediaType.parseMediaType("application/zip")).body(vault.exportZip());
    }
}
