package local.neuronvault;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.junit.jupiter.api.Assertions.*;

class LocalRequestFilterTest {
    private MockHttpServletRequest navigation(String method, String path) {
        MockHttpServletRequest request = new MockHttpServletRequest(method, path);
        request.addHeader("Host", "127.0.0.1:8787");
        request.addHeader("Sec-Fetch-Site", "cross-site");
        request.addHeader("Sec-Fetch-Mode", "navigate");
        request.addHeader("Sec-Fetch-Dest", "document");
        request.setContentType("application/json");
        return request;
    }

    private void check(LocalRequestFilter filter, MockHttpServletRequest request, boolean allowed) throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(request, response, chain);
        assertEquals(allowed ? 200 : 403, response.getStatus(), request.getMethod() + " " + request.getRequestURI());
        if (allowed) assertSame(request, chain.getRequest());
        else {
            assertNull(chain.getRequest());
            assertTrue(response.getContentAsString().contains("仅允许本机受信页面访问"));
        }
    }

    @Test void linksCanOpenOnlyTheApplicationHomeAsATopLevelDocument() throws Exception {
        for (String method : new String[]{"GET", "HEAD"})
            for (String path : new String[]{"/", "/index.html"})
                check(new LocalRequestFilter(), navigation(method, path), true);
    }

    @Test void documentNavigationDoesNotExposeApiOrAttachments() throws Exception {
        for (String path : new String[]{"/api/notes", "/api/settings", "/api/export", "/api/assets/example.png",
                "/assets/index.js", "/index.html/../api/notes", "//"})
            check(new LocalRequestFilter(), navigation("GET", path), false);
    }

    @Test void embeddedAndFetchRequestsCannotUseTheHomeNavigationException() throws Exception {
        for (String[] headers : new String[][]{{"navigate", "iframe"}, {"no-cors", "image"}, {"cors", "empty"},
                {"navigate", null}, {null, "document"}, {null, null}}) {
            MockHttpServletRequest request = navigation("GET", "/");
            request.removeHeader("Sec-Fetch-Mode"); request.removeHeader("Sec-Fetch-Dest");
            if (headers[0] != null) request.addHeader("Sec-Fetch-Mode", headers[0]);
            if (headers[1] != null) request.addHeader("Sec-Fetch-Dest", headers[1]);
            check(new LocalRequestFilter(), request, false);
        }
    }

    @Test void navigationHeadersNeverAllowCrossSiteMutations() throws Exception {
        for (String method : new String[]{"POST", "PUT", "DELETE", "PATCH", "OPTIONS"})
            check(new LocalRequestFilter(), navigation(method, "/"), false);
    }

    @Test void homeNavigationStillRequiresTrustedHostAndOrigin() throws Exception {
        MockHttpServletRequest foreignHost = navigation("GET", "/");
        foreignHost.removeHeader("Host"); foreignHost.addHeader("Host", "evil.example:8787");
        check(new LocalRequestFilter(), foreignHost, false);
        for (String origin : new String[]{"https://evil.example", "null", "http://localhost:9999"}) {
            MockHttpServletRequest request = navigation("GET", "/");
            request.addHeader("Origin", origin);
            check(new LocalRequestFilter(), request, false);
        }
    }

    @Test void directAndSameOriginRequestsWorkOnTheConfiguredPort() throws Exception {
        for (String site : new String[]{null, "none", "same-origin"}) {
            MockHttpServletRequest request = navigation("GET", "/api/health");
            request.removeHeader("Host"); request.addHeader("Host", "localhost:18787");
            request.removeHeader("Sec-Fetch-Site");
            if (site != null) request.addHeader("Sec-Fetch-Site", site);
            request.addHeader("Origin", "http://localhost:18787");
            check(new LocalRequestFilter(18787), request, true);
        }
    }
}
