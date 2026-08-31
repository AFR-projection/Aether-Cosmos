import { getFileExtension, getMimeCategory } from "@/shared/lib/utils";

export type PreviewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "csv"
  | "spreadsheet"
  | "document"
  | "presentation"
  | "svg"
  | "archive"
  | "unsupported";

const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v", "ogv"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus", "weba"]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "avif", "heic", "heif"]);
const PDF_EXT = new Set(["pdf"]);
const SPREADSHEET_EXT = new Set(["xls", "xlsx", "xlsm", "xlsb", "ods", "csv", "tsv"]);
const DOCUMENT_EXT = new Set(["doc", "docx", "odt", "rtf"]);
const PRESENTATION_EXT = new Set(["ppt", "pptx", "odp"]);
const ARCHIVE_EXT = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz"]);
const CSV_EXT = new Set(["csv", "tsv"]);

/** Executable / app installers — never inline preview */
const APP_EXTENSIONS = new Set([
  "exe", "msi", "msix", "appx", "app", "dmg", "pkg", "deb", "rpm", "apk", "ipa",
  "bat", "cmd", "com", "scr", "pif", "vbs", "vbe", "wsf", "wsh",
  "dll", "so", "dylib", "bin", "run", "jar", "war", "ear",
]);

const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/css",
  "text/javascript",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
]);

const CODE_EXTENSIONS = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "cpp", "h", "hpp", "cs", "php", "html", "htm", "css", "scss", "less", "sass",
  "json", "yaml", "yml", "toml", "xml", "sql", "sh", "bash", "zsh", "fish", "ps1", "bat",
  "vue", "svelte", "astro", "env", "gitignore", "dockerignore", "log", "ini", "cfg", "conf", "md", "mdx",
]);

function kindFromExtension(ext: string): PreviewKind | null {
  if (APP_EXTENSIONS.has(ext)) return "unsupported";
  if (ext === "svg") return "svg";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (IMAGE_EXT.has(ext)) return "image";
  if (PDF_EXT.has(ext)) return "pdf";
  if (CSV_EXT.has(ext)) return "csv";
  if (SPREADSHEET_EXT.has(ext)) return "spreadsheet";
  if (DOCUMENT_EXT.has(ext)) return "document";
  if (PRESENTATION_EXT.has(ext)) return "presentation";
  if (ARCHIVE_EXT.has(ext)) return "archive";
  if (CODE_EXTENSIONS.has(ext)) return "text";
  return null;
}

/** Resolve the best inline preview strategy from MIME type and filename. */
export function detectPreviewKind(mimeType: string, fileName: string): PreviewKind {
  const ext = getFileExtension(fileName);

  if (APP_EXTENSIONS.has(ext)) return "unsupported";

  const category = getMimeCategory(mimeType);

  if (mimeType === "image/svg+xml" || ext === "svg") return "svg";
  if (category === "image") return "image";
  if (category === "video") return "video";
  if (category === "audio") return "audio";
  if (category === "pdf" || PDF_EXT.has(ext)) return "pdf";
  if (category === "archive") return "archive";
  if (CSV_EXT.has(ext) || mimeType === "text/csv") return "csv";

  if (category === "spreadsheet" || SPREADSHEET_EXT.has(ext)) return "spreadsheet";
  if (category === "document" || DOCUMENT_EXT.has(ext)) return "document";
  if (category === "presentation" || PRESENTATION_EXT.has(ext)) return "presentation";

  if (category === "text" || TEXT_MIMES.has(mimeType) || CODE_EXTENSIONS.has(ext)) {
    return "text";
  }

  if (mimeType === "application/octet-stream" || category === "other") {
    const fromExt = kindFromExtension(ext);
    if (fromExt) return fromExt;
  }

  return "unsupported";
}
