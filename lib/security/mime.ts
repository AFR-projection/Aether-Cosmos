/**
 * Security utilities for MIME type handling
 * Prevents XSS via malicious file types (SVG, HTML, etc.)
 */

// Dangerous extensions that should NEVER be rendered inline, always forced download
const FORCED_DOWNLOAD_EXTENSIONS = new Set([
  "exe", "bat", "cmd", "com", "msi", "scr", "pif", "vbs", "vbe", "wsf", "wsh",
  "sh", "bash", "csh", "ksh", "zsh", "fish",
  "php", "phtml", "php3", "php4", "php5", "php7",
  "pl", "py", "rb", "js", "mjs", "cjs",
  "ps1", "psm1", "psd1",
  "jsp", "jspx", "asp", "aspx", "ascx", "ashx", "asmx",
  "htaccess", "htpasswd",
  "env", "git", "svn", "hg",
  "svg", "html", "htm", "xhtml",
  "xml", "xsl", "xslt",
  "jar", "war", "ear",
  "dll", "so", "dylib", "bin",
  "reg", "inf", "ini",
  "iso", "img", "vmdk",
]);

function getExtension(filename: string): string {
  const parts = filename.split(".");
  return parts.length > 1 ? (parts.pop()?.toLowerCase() ?? "") : "";
}

/**
 * Returns a safe MIME type for serving files inline.
 * Forces dangerous extensions to application/octet-stream (download mode).
 */
export function getSafeMimeType(mimeType: string, filename: string): string {
  const ext = getExtension(filename);

  if (FORCED_DOWNLOAD_EXTENSIONS.has(ext)) {
    return "application/octet-stream";
  }

  if (mimeType === "image/svg+xml" || ext === "svg") {
    return "application/octet-stream";
  }

  // Block any HTML-like MIME types
  if (mimeType.includes("html") || mimeType.includes("xml")) {
    return "application/octet-stream";
  }

  return mimeType;
}

/**
 * Determines if a file should be forced to download (attachment) vs inline rendering
 */
export function shouldForceDownload(filename: string): boolean {
  const ext = getExtension(filename);
  return FORCED_DOWNLOAD_EXTENSIONS.has(ext);
}
