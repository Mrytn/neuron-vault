package local.neuronvault;

import com.fasterxml.jackson.databind.*;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import java.net.*;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicReference;
import static local.neuronvault.Models.*;
import static org.assertj.core.api.Assertions.*;

class AiServiceTest {
    @TempDir Path temp;
    final ObjectMapper mapper = new ObjectMapper();
    VaultService vault; SettingsService settings; HttpServer server;
    @BeforeEach void setup() throws Exception { vault = new VaultService(temp.resolve("data"), mapper); settings = new SettingsService(vault, mapper); }
    @AfterEach void stop() { if (server != null) server.stop(0); }
    String server(String route, int status, String reply, AtomicReference<String> request) throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext(route, exchange -> {
            request.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] body = reply.getBytes(StandardCharsets.UTF_8); exchange.sendResponseHeaders(status, body.length);
            try (var out = exchange.getResponseBody()) { out.write(body); }
        }); server.start(); return "http://127.0.0.1:" + server.getAddress().getPort() + "/v1";
    }
    void note() throws Exception { vault.create(new NoteInput("检索", "", "向量检索使用相关片段。" + "文".repeat(6000) + "\nDO_NOT_SEND_WHOLE_DOCUMENT_SENTINEL", null)); }
    @Test void withoutCredentialsReturnsHonestLocalEvidenceAndAbstainsWhenAbsent() throws Exception {
        note(); AiService ai = new AiService(vault, settings, mapper);
        AskResult local = ai.ask("向量检索");
        assertThat(local.mode()).isEqualTo("local"); assertThat(local.answer()).contains("未进行模型推理"); assertThat(local.sources()).hasSize(1);
        AskResult empty = ai.ask("不存在的火星价格"); assertThat(empty.sources()).isEmpty(); assertThat(empty.mode()).isEqualTo("local");
    }
    @Test void responsesUsesOnlyBoundedSnippetsAndStoreFalseAndParsesMessageOutput() throws Exception {
        note(); AtomicReference<String> body = new AtomicReference<>();
        String base = server("/v1/responses", 200, "{\"status\":\"completed\",\"output\":[{\"type\":\"reasoning\",\"summary\":[]},{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"使用相关片段。[1]\"}]}]}", body);
        settings.update(new SettingsInput("openai", base, "test-user-model", "FAKE_KEY"));
        AskResult answer = new AiService(vault, settings, mapper).ask("向量检索");
        assertThat(answer.mode()).isEqualTo("cloud"); assertThat(answer.answer()).contains("[1]");
        JsonNode sent = mapper.readTree(body.get()); assertThat(sent.path("store").asBoolean(true)).isFalse(); assertThat(sent.path("model").asText()).isEqualTo("test-user-model");
        assertThat(body.get()).doesNotContain("DO_NOT_SEND_WHOLE_DOCUMENT_SENTINEL", "FAKE_KEY");
        assertThat(sent.path("input").asText().length()).isLessThan(1200);
    }
    @Test void compatibleUsesChatCompletions() throws Exception {
        note(); AtomicReference<String> body = new AtomicReference<>();
        String base = server("/v1/chat/completions", 200, "{\"choices\":[{\"message\":{\"content\":\"检索相关片段。[1]\"}}]}", body);
        settings.update(new SettingsInput("compatible", base, "user-model", "FAKE_KEY"));
        assertThat(new AiService(vault, settings, mapper).ask("向量检索").mode()).isEqualTo("cloud");
        assertThat(mapper.readTree(body.get()).path("messages")).hasSize(2);
    }
    @Test void providerFailureIsExplicitAndDoesNotLeakBodyOrSecret() throws Exception {
        note(); String base = server("/v1/responses", 401, "FAKE_KEY must not be relayed", new AtomicReference<>());
        settings.update(new SettingsInput("openai", base, "test", "FAKE_KEY"));
        assertThatThrownBy(() -> new AiService(vault, settings, mapper).ask("向量检索"))
                .isInstanceOfSatisfying(ApiException.class, e -> { assertThat(e.status).isEqualTo(502); assertThat(e.getMessage()).contains("401").doesNotContain("FAKE_KEY"); });
    }
    @Test void missingCitationIsRejectedInsteadOfInventingEvidence() throws Exception {
        note(); String base = server("/v1/chat/completions", 200, "{\"choices\":[{\"message\":{\"content\":\"没有引用的回答\"}}]}", new AtomicReference<>());
        settings.update(new SettingsInput("compatible", base, "test", "FAKE_KEY"));
        assertThatThrownBy(() -> new AiService(vault, settings, mapper).ask("向量检索"))
                .isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.status).isEqualTo(502));
    }
    @Test void timeoutIsExplicit() throws Exception {
        note(); server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/responses", exchange -> { try { Thread.sleep(300); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } exchange.close(); }); server.start();
        settings.update(new SettingsInput("openai", "http://127.0.0.1:" + server.getAddress().getPort() + "/v1", "test", "FAKE_KEY"));
        AiService ai = new AiService(vault, settings, mapper, HttpClient.newHttpClient(), Duration.ofMillis(60));
        assertThatThrownBy(() -> ai.ask("向量检索")).isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.status).isEqualTo(504));
    }
    @Test void incompleteSourcesAreSearchableButNeverSentOrUsedAsLocalEvidence() throws Exception {
        var metadata = new java.util.ArrayList<VaultService.Meta>();
        for (int i = 0; i < 55; i++) {
            var m = new VaultService.Meta(); m.id = "missing-" + i; m.sourceId = m.id;
            m.sourceStatus = i % 2 == 0 ? "missing_body" : "encrypted";
            m.title = "向量检索"; m.path = m.id + ".md"; metadata.add(m);
            Files.writeString(vault.vaultPath().resolve(m.path), "向量检索 INCOMPLETE_SENTINEL");
        }
        mapper.writeValue(vault.root.resolve(".metadata/index.json").toFile(), metadata);
        vault = new VaultService(vault.root, mapper); settings = new SettingsService(vault, mapper);
        assertThat(vault.search("向量检索")).hasSize(50);
        AskResult empty = new AiService(vault, settings, mapper).ask("向量检索");
        assertThat(empty.sources()).isEmpty(); assertThat(empty.answer()).doesNotContain("INCOMPLETE_SENTINEL");
        Note valid = vault.create(new NoteInput("完整资料", "", "向量检索 VALID_SENTINEL", null));
        assertThat(new AiService(vault, settings, mapper).ask("向量检索").sources()).extracting(Source::id).containsExactly(valid.id());
        AtomicReference<String> body = new AtomicReference<>();
        String base = server("/v1/chat/completions", 200, "{\"choices\":[{\"message\":{\"content\":\"完整资料。[1]\"}}]}", body);
        settings.update(new SettingsInput("compatible", base, "test", "FAKE_KEY"));
        assertThat(new AiService(vault, settings, mapper).ask("向量检索").sources()).extracting(Source::id).containsExactly(valid.id());
        assertThat(body.get()).contains("VALID_SENTINEL").doesNotContain("INCOMPLETE_SENTINEL", "missing-", "FAKE_KEY");
    }
    @Test void settingsAreRedactedPrivateAndBlankKeyPreservesExisting() throws Exception {
        SettingsView view = settings.update(new SettingsInput("compatible", "http://127.0.0.1:1/v1", "user-model", "FAKE_SECRET_SENTINEL"));
        assertThat(mapper.writeValueAsString(view)).doesNotContain("FAKE_SECRET_SENTINEL", "apiKey");
        assertThat(view.vaultPath()).isEqualTo(vault.vaultPath().toString());
        assertThat(Files.getPosixFilePermissions(vault.root.resolve(".config/settings.json"))).isEqualTo(PosixFilePermissions.fromString("rw-------"));
        settings.update(new SettingsInput("compatible", "http://127.0.0.1:1/v1", "changed-model", ""));
        assertThat(settings.config().apiKey).isEqualTo("FAKE_SECRET_SENTINEL");
        assertThatThrownBy(() -> settings.update(new SettingsInput("compatible", "http://example.com/v1", "m", "k"))).isInstanceOf(ApiException.class);
    }
}
