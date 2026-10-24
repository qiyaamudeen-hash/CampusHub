import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

import static java.nio.charset.StandardCharsets.UTF_8;

/**
 * CampusHub local file server (JDK only, no libraries).
 *
 *   Run:   java UploadServer.java              (Java 11 or newer)
 *          java UploadServer.java --lan        (also reachable from other PCs on your network)
 *          java UploadServer.java D:\MyUploads (save somewhere other than ~/CampusHubUploads)
 *
 *   POST /upload          raw file as the request body, original name in the X-File-Name header
 *                         -> {"storedName":"<uuid>.ext","originalName":"...","size":123}
 *   GET  /files/<stored>  serves the file back (optional ?name=Original.pdf sets the download name)
 *
 * Firestore only ever stores the storedName; the bytes live in the upload folder.
 * NOTE: this server does not check who is uploading. Fine for a local demo; see README.
 */
public class UploadServer {

    static final int PORT = 8081;
    static final int MAX_BYTES = 10 * 1024 * 1024; // 10 MB

    // Only these file types are accepted. Extension -> the MIME type we serve it back as.
    static final Map<String, String> TYPES = Map.ofEntries(
        Map.entry("png", "image/png"),
        Map.entry("jpg", "image/jpeg"),
        Map.entry("jpeg", "image/jpeg"),
        Map.entry("gif", "image/gif"),
        Map.entry("webp", "image/webp"),
        Map.entry("pdf", "application/pdf"),
        Map.entry("txt", "text/plain; charset=utf-8"),
        Map.entry("doc", "application/msword"),
        Map.entry("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        Map.entry("ppt", "application/vnd.ms-powerpoint"),
        Map.entry("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        Map.entry("xls", "application/vnd.ms-excel"),
        Map.entry("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    );

    // Stored names are always "<random uuid>.<ext>" -- anything else is rejected, which also rules out ../ tricks.
    static final Pattern STORED_NAME =
        Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.[a-z0-9]{2,4}");

    static Path uploadDir;

    interface Handler { void handle(HttpExchange ex) throws Exception; }

    public static void main(String[] args) throws IOException {
        boolean lan = false;
        String dir = null;
        for (String a : args) {
            if (a.equals("--lan")) lan = true; else dir = a;
        }
        uploadDir = (dir != null ? Paths.get(dir) : Paths.get(System.getProperty("user.home"), "CampusHubUploads"))
            .toAbsolutePath().normalize();
        Files.createDirectories(uploadDir);

        InetSocketAddress addr = lan
            ? new InetSocketAddress(PORT)
            : new InetSocketAddress(InetAddress.getLoopbackAddress(), PORT);
        HttpServer server = HttpServer.create(addr, 0);
        server.createContext("/upload", ex -> guarded(ex, UploadServer::handleUpload));
        server.createContext("/files/", ex -> guarded(ex, UploadServer::handleFile));
        server.setExecutor(Executors.newFixedThreadPool(8));
        server.start();

        System.out.println("CampusHub upload server running (Ctrl+C to stop)");
        System.out.println("  Upload URL      : http://localhost:" + PORT + "/upload" + (lan ? "   (also open to your network)" : ""));
        System.out.println("  Saving files to : " + uploadDir);
    }

    // ---------------- request handling ----------------

    static void guarded(HttpExchange ex, Handler h) throws IOException {
        try {
            var out = ex.getResponseHeaders();
            out.set("Access-Control-Allow-Origin", "*");
            out.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            out.set("Access-Control-Allow-Headers", "X-File-Name, Content-Type");
            if (ex.getRequestMethod().equals("OPTIONS")) {   // browser CORS preflight
                ex.sendResponseHeaders(204, -1);
                return;
            }
            h.handle(ex);
        } catch (Exception e) {
            e.printStackTrace();
            try { send(ex, 500, "text/plain; charset=utf-8", "Server error."); } catch (Exception ignored) { }
        } finally {
            ex.close();
        }
    }

    static void handleUpload(HttpExchange ex) throws IOException {
        if (!ex.getRequestURI().getPath().equals("/upload")) { send(ex, 404, "text/plain; charset=utf-8", "Not found."); return; }
        if (!ex.getRequestMethod().equals("POST")) { send(ex, 405, "text/plain; charset=utf-8", "Use POST."); return; }

        String original;
        try {
            String raw = ex.getRequestHeaders().getFirst("X-File-Name");
            original = cleanName(raw == null ? "" : URLDecoder.decode(raw, UTF_8));
        } catch (IllegalArgumentException e) {
            send(ex, 400, "text/plain; charset=utf-8", "Bad file name.");
            return;
        }

        int dot = original.lastIndexOf('.');
        String ext = dot >= 0 ? original.substring(dot + 1).toLowerCase() : "";
        if (!TYPES.containsKey(ext)) {
            send(ex, 415, "text/plain; charset=utf-8", "That file type isn't allowed. Allowed: " + String.join(", ", new java.util.TreeSet<>(TYPES.keySet())) + ".");
            return;
        }

        byte[] data;
        try (InputStream in = ex.getRequestBody()) {
            data = in.readNBytes(MAX_BYTES + 1);   // read one byte past the limit so we can tell it's too big
        }
        if (data.length > MAX_BYTES) { send(ex, 413, "text/plain; charset=utf-8", "File is over 10 MB."); return; }
        if (data.length == 0) { send(ex, 400, "text/plain; charset=utf-8", "Empty file."); return; }

        String stored = UUID.randomUUID() + "." + ext;
        Files.write(uploadDir.resolve(stored), data);

        String json = "{\"storedName\":\"" + stored + "\",\"originalName\":\"" + jsonEscape(original)
                    + "\",\"size\":" + data.length + "}";
        send(ex, 200, "application/json; charset=utf-8", json);
    }

    static void handleFile(HttpExchange ex) throws IOException {
        if (!ex.getRequestMethod().equals("GET")) { send(ex, 405, "text/plain; charset=utf-8", "Use GET."); return; }

        String name = ex.getRequestURI().getPath().substring("/files/".length());
        if (!STORED_NAME.matcher(name).matches()) { send(ex, 404, "text/plain; charset=utf-8", "Not found."); return; }

        Path file = uploadDir.resolve(name).normalize();
        String type = TYPES.get(name.substring(name.lastIndexOf('.') + 1));
        if (type == null || !file.startsWith(uploadDir) || !Files.isRegularFile(file)) {
            send(ex, 404, "text/plain; charset=utf-8", "Not found.");
            return;
        }

        var out = ex.getResponseHeaders();
        out.set("Content-Type", type);
        out.set("X-Content-Type-Options", "nosniff");
        out.set("Cache-Control", "public, max-age=86400");   // names are unique, so a cached copy is never stale
        String downloadName = queryParam(ex.getRequestURI().getRawQuery(), "name");
        if (downloadName != null && !downloadName.isEmpty()) {
            String enc = URLEncoder.encode(downloadName, UTF_8).replace("+", "%20").replace("*", "%2A");
            out.set("Content-Disposition", "inline; filename*=UTF-8''" + enc);
        }

        ex.sendResponseHeaders(200, Files.size(file));
        try (OutputStream os = ex.getResponseBody()) { Files.copy(file, os); }
    }

    // ---------------- helpers ----------------

    static void send(HttpExchange ex, int code, String contentType, String body) throws IOException {
        byte[] bytes = body.getBytes(UTF_8);
        ex.getResponseHeaders().set("Content-Type", contentType);
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }

    // Keep just the file name (no folders), drop control characters, quotes and angle brackets, cap the length.
    static String cleanName(String s) {
        s = s.substring(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
        s = s.replaceAll("[\\p{Cntrl}\"<>]", "").trim();
        if (s.length() > 150) s = s.substring(s.length() - 150);
        return s;
    }

    static String jsonEscape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    static String queryParam(String rawQuery, String key) {
        if (rawQuery == null) return null;
        for (String pair : rawQuery.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0 && pair.substring(0, eq).equals(key)) {
                try { return cleanName(URLDecoder.decode(pair.substring(eq + 1), UTF_8)); }
                catch (IllegalArgumentException e) { return null; }
            }
        }
        return null;
    }
}
