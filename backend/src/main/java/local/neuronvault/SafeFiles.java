package local.neuronvault;

import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;

final class SafeFiles {
    private SafeFiles() {}
    static void rejectSymlinks(Path path) throws IOException {
        Path absolute = path.toAbsolutePath().normalize();
        Path part = absolute.getRoot();
        for (Path component : absolute) {
            part = part.resolve(component);
            if (Files.isSymbolicLink(part)) throw ApiException.bad("不允许通过符号链接访问数据。");
        }
    }
    static Path beneath(Path root, String relative) throws IOException {
        if (relative == null || relative.indexOf('\0') >= 0 || relative.contains("\\"))
            throw ApiException.bad("无效的相对路径。");
        Path input;
        try { input = Path.of(relative); } catch (InvalidPathException e) { throw ApiException.bad("无效路径。"); }
        if (input.isAbsolute()) throw ApiException.bad("不允许绝对路径。");
        for (Path part : input) {
            if (part.toString().equals("..") || part.toString().equals(".")) throw ApiException.bad("不允许路径跳转。");
        }
        Path target = root.resolve(input).normalize();
        if (!target.startsWith(root.normalize())) throw ApiException.bad("路径超出知识库。");
        rejectSymlinks(target);
        return target;
    }
    static void privateDirectory(Path path) throws IOException {
        rejectSymlinks(path);
        Files.createDirectories(path);
        Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rwx------"));
    }
    static void writeAtomic(Path path, byte[] content, boolean secret) throws IOException {
        rejectSymlinks(path);
        Files.createDirectories(path.getParent());
        rejectSymlinks(path.getParent());
        Path temp = Files.createTempFile(path.getParent(), ".vault-write-", ".tmp",
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        try {
            Files.write(temp, content);
            rejectSymlinks(path);
            try { Files.move(temp, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
            catch (AtomicMoveNotSupportedException e) { Files.move(temp, path, StandardCopyOption.REPLACE_EXISTING); }
            if (secret) Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));
        } finally { Files.deleteIfExists(temp); }
    }
    static Path resolveRoot(String configured, Path cwd) {
        if (configured != null && !configured.isBlank()) return Path.of(configured).toAbsolutePath().normalize();
        Path current = cwd.toAbsolutePath().normalize();
        for (Path p = current; p != null; p = p.getParent()) {
            if (Files.isRegularFile(p.resolve("CONTRACT.md")) && Files.isDirectory(p.resolve("backend"))) return p.resolve("data");
        }
        if (current.getFileName() != null && current.getFileName().toString().equals("backend")) current = current.getParent();
        return current.resolve("data");
    }
    static boolean exportable(Path relative) {
        for (Path component : relative) {
            String name = component.toString().toLowerCase();
            if (name.startsWith(".") || List.of("node_modules", "target").contains(name)
                    || name.endsWith(".key") || name.endsWith(".pem") || name.endsWith(".p12") || name.endsWith(".pfx")) return false;
        }
        return true;
    }
}
