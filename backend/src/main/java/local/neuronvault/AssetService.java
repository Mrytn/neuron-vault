package local.neuronvault;

import org.springframework.stereotype.Service;
import java.io.IOException;
import java.nio.file.*;
import java.util.Locale;
import java.util.Map;

@Service
public class AssetService {
    public record Asset(byte[] bytes, String filename, String mediaType, boolean inline) {}
    private final VaultService vault;
    private static final Map<String, String> IMAGES = Map.of("png", "image/png", "jpg", "image/jpeg", "jpeg", "image/jpeg",
            "gif", "image/gif", "webp", "image/webp", "avif", "image/avif", "bmp", "image/bmp", "ico", "image/x-icon");
    public AssetService(VaultService vault) { this.vault = vault; }
    public Asset get(String requested) throws IOException {
        String relative = requested != null && requested.startsWith("/") ? requested.substring(1) : requested;
        if (relative == null || relative.isBlank()) throw new ApiException(404, "附件不存在。");
        Path base = vault.vaultPath().resolve("assets");
        Path path = SafeFiles.beneath(base, relative);
        if (!SafeFiles.exportable(base.relativize(path))) throw new ApiException(403, "不允许读取此附件。");
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) throw new ApiException(404, "附件不存在。");
        if (Files.size(path) > 40L * 1024 * 1024) throw new ApiException(413, "附件过大，请从本地目录打开。");
        SafeFiles.rejectSymlinks(path);
        String filename = path.getFileName().toString();
        String ext = filename.contains(".") ? filename.substring(filename.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
        String mime = IMAGES.get(ext);
        // SVG, HTML and other active formats are downloads, never same-origin executable documents.
        return new Asset(Files.readAllBytes(path), filename, mime == null ? "application/octet-stream" : mime, mime != null);
    }
}
