package local.neuronvault;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.core.Ordered;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import java.io.IOException;
import java.net.URI;
import java.util.Set;
import java.util.HashSet;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class LocalRequestFilter extends OncePerRequestFilter {
    private final Set<Integer> ports;
    public LocalRequestFilter() { this(8787); }
    @Autowired
    public LocalRequestFilter(@Value("${server.port:8787}") int serverPort) {
        Set<Integer> allowed = new HashSet<>(Set.of(8787, 5173, 4173));
        if (serverPort > 0 && serverPort <= 65535) allowed.add(serverPort);
        this.ports = Set.copyOf(allowed);
    }
    private static boolean local(String host) { return "127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host) || "[::1]".equals(host); }
    boolean allowedAuthority(String authority) {
        if (authority == null || authority.isBlank()) return false;
        try {
            URI uri = URI.create("http://" + authority);
            return local(uri.getHost()) && ports.contains(uri.getPort()) && uri.getRawUserInfo() == null
                    && uri.getRawQuery() == null && uri.getRawFragment() == null && (uri.getRawPath() == null || uri.getRawPath().isEmpty());
        } catch (IllegalArgumentException e) { return false; }
    }
    boolean allowedOrigin(String origin) {
        if (origin == null) return true;
        try {
            URI uri = URI.create(origin);
            return "http".equals(uri.getScheme()) && local(uri.getHost()) && ports.contains(uri.getPort())
                    && uri.getRawUserInfo() == null && uri.getRawQuery() == null && uri.getRawFragment() == null
                    && (uri.getRawPath() == null || uri.getRawPath().isEmpty());
        } catch (IllegalArgumentException e) { return false; }
    }
    private boolean homeNavigation(HttpServletRequest request) {
        // Links from other sites may open the app shell, never note APIs or attachments.
        return ("GET".equals(request.getMethod()) || "HEAD".equals(request.getMethod()))
                && ("/".equals(request.getRequestURI()) || "/index.html".equals(request.getRequestURI()))
                && "navigate".equalsIgnoreCase(request.getHeader("Sec-Fetch-Mode"))
                && "document".equalsIgnoreCase(request.getHeader("Sec-Fetch-Dest"));
    }
    @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
        response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("Cache-Control", "no-store");
        if (!allowedAuthority(request.getHeader("Host")) || !allowedOrigin(request.getHeader("Origin"))
                || ("cross-site".equalsIgnoreCase(request.getHeader("Sec-Fetch-Site")) && !homeNavigation(request))) {
            reject(response, 403, "仅允许本机受信页面访问。"); return;
        }
        if (request.getContentLengthLong() > 20_000_000) { reject(response, 413, "请求内容过大，请分批处理。"); return; }
        if (request.getMethod().equals("POST") || request.getMethod().equals("PUT")) {
            String type = request.getContentType();
            if (request.getContentLengthLong() != 0 && !request.getRequestURI().endsWith("/restore")
                    && (type == null || !type.toLowerCase().startsWith("application/json"))) {
                reject(response, 415, "请使用 application/json 请求格式。"); return;
            }
        }
        chain.doFilter(request, response);
    }
    private void reject(HttpServletResponse response, int status, String error) throws IOException {
        response.setStatus(status); response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write("{\"error\":\"" + error + "\"}");
    }
}
