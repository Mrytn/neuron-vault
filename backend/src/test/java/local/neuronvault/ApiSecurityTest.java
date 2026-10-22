package local.neuronvault;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.servlet.*;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import java.nio.file.Path;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class ApiSecurityTest {
    @TempDir Path temp; MockMvc mvc;
    @BeforeEach void setup() throws Exception {
        ObjectMapper mapper = new ObjectMapper(); VaultService vault = new VaultService(temp.resolve("data"), mapper);
        SettingsService settings = new SettingsService(vault, mapper);
        mvc = MockMvcBuilders.standaloneSetup(new ApiController(vault, settings, new AiService(vault, settings, mapper)))
                .setControllerAdvice(new ApiErrors()).addFilters(new LocalRequestFilter()).build();
    }
    @Test void trustedLocalRequestWorks() throws Exception {
        mvc.perform(get("/api/health").header("Host", "127.0.0.1:8787").header("Origin", "http://localhost:5173"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("ok"));
    }
    @Test void dnsRebindingHostIsRejected() throws Exception {
        mvc.perform(get("/api/notes").header("Host", "evil.example:8787")).andExpect(status().isForbidden()).andExpect(jsonPath("$.error").exists());
    }
    @Test void foreignOriginAndNullOriginAreRejected() throws Exception {
        for (String origin : new String[]{"https://evil.example", "null", "http://localhost:9999", "http://localhost:5173/evil"})
            mvc.perform(get("/api/notes").header("Host", "127.0.0.1:8787").header("Origin", origin)).andExpect(status().isForbidden());
    }
    @Test void crossSiteAndNonJsonMutationsAreRejected() throws Exception {
        mvc.perform(delete("/api/notes/anything").header("Host", "localhost:8787").header("Sec-Fetch-Site", "cross-site")).andExpect(status().isForbidden());
        mvc.perform(post("/api/notes").header("Host", "localhost:8787").contentType("text/plain").content("{}")).andExpect(status().isUnsupportedMediaType());
    }
    @Test void missingNoteAndMalformedJsonUseContractErrors() throws Exception {
        mvc.perform(get("/api/notes/unknown").header("Host", "localhost:8787")).andExpect(status().isNotFound()).andExpect(jsonPath("$.error").exists());
        mvc.perform(post("/api/notes").header("Host", "localhost:8787").contentType("application/json").content("broken")).andExpect(status().isBadRequest()).andExpect(jsonPath("$.error").exists());
    }
}
