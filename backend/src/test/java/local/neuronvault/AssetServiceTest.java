package local.neuronvault;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import java.nio.file.*;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class AssetServiceTest {
    @TempDir Path temp;
    VaultService vault;
    AssetService assets;
    MockMvc mvc;
    @BeforeEach void setup() throws Exception {
        ObjectMapper mapper = new ObjectMapper(); vault = new VaultService(temp.resolve("data"), mapper);
        SettingsService settings = new SettingsService(vault, mapper); assets = new AssetService(vault);
        mvc = MockMvcBuilders.standaloneSetup(new ApiController(vault, settings, new AiService(vault, settings, mapper)))
                .setControllerAdvice(new ApiErrors()).addFilters(new LocalRequestFilter(18787)).build();
        Files.createDirectories(vault.vaultPath().resolve("assets/youdao/note-1"));
    }
    @Test void nestedImageIsReadOnlyAndUsesExpectedMime() throws Exception {
        byte[] bytes = new byte[]{(byte) 137, 80, 78, 71};
        Files.write(vault.vaultPath().resolve("assets/youdao/note-1/image.png"), bytes);
        mvc.perform(get("/api/assets/youdao/note-1/image.png").header("Host", "localhost:18787"))
                .andExpect(status().isOk()).andExpect(content().contentType("image/png"))
                .andExpect(content().bytes(bytes)).andExpect(header().string("X-Content-Type-Options", "nosniff"));
        mvc.perform(post("/api/assets/youdao/note-1/image.png").header("Host", "localhost:18787").contentType("application/json").content("{}"))
                .andExpect(status().isMethodNotAllowed());
    }
    @Test void activeContentIsDownloadedInsteadOfExecuted() throws Exception {
        for (String filename : java.util.List.of("unsafe.svg", "原始笔记.html")) {
            Files.writeString(vault.vaultPath().resolve("assets/youdao/note-1/" + filename), "<script>alert(1)</script>");
            mvc.perform(get("/api/assets/youdao/note-1/" + filename).header("Host", "localhost:18787"))
                    .andExpect(status().isOk()).andExpect(content().contentType("application/octet-stream"))
                    .andExpect(header().string("Content-Disposition", org.hamcrest.Matchers.startsWith("attachment")))
                    .andExpect(header().string("Content-Security-Policy", "default-src 'none'; sandbox"));
        }
    }
    @Test void traversalSecretsAndSymlinksAreRejected() throws Exception {
        assertThatThrownBy(() -> assets.get("../.config/settings.json")).isInstanceOf(ApiException.class);
        Files.writeString(vault.vaultPath().resolve("assets/.env"), "secret");
        assertThatThrownBy(() -> assets.get(".env")).isInstanceOf(ApiException.class);
        Path outside = temp.resolve("outside.png"); Files.writeString(outside, "private");
        Files.createSymbolicLink(vault.vaultPath().resolve("assets/alias.png"), outside);
        assertThatThrownBy(() -> assets.get("alias.png")).isInstanceOf(ApiException.class);
    }
    @Test void configuredPortIsAllowedButOtherOriginsAreNot() throws Exception {
        mvc.perform(get("/api/health").header("Host", "127.0.0.1:18787").header("Origin", "http://localhost:18787"))
                .andExpect(status().isOk());
        mvc.perform(get("/api/health").header("Host", "127.0.0.1:18787").header("Origin", "http://localhost:28787"))
                .andExpect(status().isForbidden());
    }
}
