package local.neuronvault;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import java.io.IOException;
import java.net.URI;
import java.nio.file.*;
import static local.neuronvault.Models.*;

@Service
public class SettingsService {
    static class Config {
        public String provider = "openai", baseUrl = "https://api.openai.com/v1", model = "", apiKey = "";
    }
    private final Path file;
    private final ObjectMapper mapper;
    private final VaultService vault;
    public SettingsService(VaultService vault, ObjectMapper mapper) throws IOException {
        this.vault = vault; this.mapper = mapper;
        Path dir = vault.root.resolve(".config"); SafeFiles.privateDirectory(dir); file = dir.resolve("settings.json");
        SafeFiles.rejectSymlinks(file);
    }
    synchronized Config config() throws IOException {
        SafeFiles.rejectSymlinks(file);
        return Files.exists(file) ? mapper.readValue(Files.readAllBytes(file), Config.class) : new Config();
    }
    private SettingsView view(Config config) {
        return new SettingsView(config.provider, config.baseUrl, config.model,
                config.apiKey != null && !config.apiKey.isBlank() && config.model != null && !config.model.isBlank(), vault.vaultPath().toString());
    }
    public synchronized SettingsView get() throws IOException { return view(config()); }
    public synchronized SettingsView update(SettingsInput input) throws IOException {
        if (input == null || !("openai".equals(input.provider()) || "compatible".equals(input.provider()))) throw ApiException.bad("不支持的模型服务类型。");
        String base = input.baseUrl() == null ? "" : input.baseUrl().strip().replaceAll("/+$", "");
        if (base.isEmpty() && input.provider().equals("openai")) base = "https://api.openai.com/v1";
        validateBaseUrl(base);
        String model = input.model() == null ? "" : input.model().strip();
        if (model.length() > 200 || model.chars().anyMatch(Character::isISOControl)) throw ApiException.bad("模型名称无效。");
        Config config = config();
        config.provider = input.provider(); config.baseUrl = base; config.model = model;
        if (input.apiKey() != null && !input.apiKey().isBlank()) {
            if (input.apiKey().length() > 2000 || input.apiKey().chars().anyMatch(Character::isISOControl)) throw ApiException.bad("API Key 格式无效。");
            config.apiKey = input.apiKey().strip();
        }
        SafeFiles.writeAtomic(file, mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(config), true);
        return view(config);
    }
    static void validateBaseUrl(String base) {
        try {
            URI uri = URI.create(base);
            boolean local = "127.0.0.1".equals(uri.getHost()) || "localhost".equalsIgnoreCase(uri.getHost()) || "[::1]".equals(uri.getHost());
            if (uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null || uri.getQuery() != null
                    || !("https".equals(uri.getScheme()) || ("http".equals(uri.getScheme()) && local))
                    || !uri.normalize().equals(uri)) throw new IllegalArgumentException();
        } catch (IllegalArgumentException e) { throw ApiException.bad("API 地址必须是 HTTPS，或本机 HTTP 地址，且不能包含凭据、查询参数或路径跳转。"); }
    }
}
