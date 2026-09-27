export class SecurityGuard {
  private static readonly MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
  private static readonly ALLOWED_EXTENSIONS = new Set([
    "txt", "md", "markdown", "json", "csv", "ts", "tsx", "js", "jsx",
    "py", "java", "c", "cpp", "h", "hpp", "sql", "html", "css", "yaml",
    "yml", "xml", "sh", "rs", "go", "php", "pdf"
  ]);

  /**
   * Prevents path traversal and directory escape
   */
  public static sanitizeFilename(filename: string): string {
    if (!filename) return "untitled.txt";
    // Remove null bytes and control chars
    let clean = filename.replace(/\0/g, "");
    // Remove path separators
    clean = clean.replace(/[/\\?%*:|"<>]/g, "_");
    // Remove relative path attempts
    clean = clean.replace(/\.{2,}/g, ".");
    return clean.slice(0, 255);
  }

  /**
   * Validates file upload constraints
   */
  public static validateUpload(filename: string, sizeBytes: number): { valid: boolean; error?: string } {
    if (sizeBytes > this.MAX_FILE_SIZE_BYTES) {
      return {
        valid: false,
        error: `File size (${Math.round(sizeBytes / (1024 * 1024))}MB) exceeds maximum allowed limit (20MB).`,
      };
    }

    const ext = filename.split(".").pop()?.toLowerCase();
    if (!ext || !this.ALLOWED_EXTENSIONS.has(ext)) {
      return {
        valid: false,
        error: `File extension '.${ext || "none"}' is not supported for indexing. Supported: ${Array.from(this.ALLOWED_EXTENSIONS).slice(0, 10).join(", ")}...`,
      };
    }

    return { valid: true };
  }

  /**
   * SSRF Protection: Checks if URL targets dangerous internal metadata endpoints
   */
  public static isSafeUrl(urlStr: string): boolean {
    try {
      const parsed = new URL(urlStr);
      const hostname = parsed.hostname.toLowerCase();

      // Block cloud metadata services
      if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") {
        return false;
      }

      // Only allow http and https
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }
}
