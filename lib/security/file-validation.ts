/*
 * There used to be a MAGIC_BYTES lookup table here, unreferenced by anything and
 * already out of step with the detector below it — it claimed `video/mp4` starts with
 * `00 00 00` (the real check is the `ftyp` box at offset 4) and listed
 * `application/vnd.ms-excel` separately when a CFB header cannot tell Word from Excel.
 * A second, wrong copy of the signatures is worse than none, and the table's shape
 * cannot express the offsets these formats actually need, so the checks in
 * `detectMimeFromBytes` are the only source of truth.
 */

export interface FileValidationResult {
  valid: boolean;
  detectedMime: string | null;
  warning?: string;
}

export function validateFileMagicBytes(
  buffer: ArrayBuffer,
  claimedMimeType: string
): FileValidationResult {
  const bytes = new Uint8Array(buffer);

  // Too few bytes to sniff — nothing to check, let it through.
  if (bytes.length < 4) {
    return { valid: true, detectedMime: null };
  }

  // Text types have no reliable magic bytes, so they are taken at their word.
  if (
    claimedMimeType.startsWith("text/") ||
    claimedMimeType === "application/json" ||
    claimedMimeType === "application/xml" ||
    claimedMimeType === "application/javascript"
  ) {
    return { valid: true, detectedMime: claimedMimeType };
  }

  const detected = detectMimeFromBytes(bytes);

  // Unrecognised signature is not a problem in itself — most formats aren't listed here.
  if (!detected) {
    return { valid: true, detectedMime: null };
  }

  // Detected and consistent with what the client claimed.
  if (isMimeMatch(detected, claimedMimeType)) {
    return { valid: true, detectedMime: detected };
  }

  // A mismatch still uploads — it is reported as a warning, not a refusal. A client that
  // says "application/octet-stream" for a JPEG is being vague, not malicious.
  return {
    valid: true,
    detectedMime: detected,
    warning: `Content appears to be ${detected} but claimed ${claimedMimeType}`,
  };
}

function detectMimeFromBytes(bytes: Uint8Array): string | null {
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  // GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  // WebP (RIFF....WEBP)
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  // BMP
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  // PDF
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
  // ZIP / Office XML (docx, xlsx, pptx)
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "application/zip";
  // RAR
  if (bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21) return "application/x-rar-compressed";
  // 7z
  if (bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc && bytes[3] === 0xaf) return "application/x-7z-compressed";
  // OGG (audio/video)
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg";
  // MP3
  if ((bytes[0] === 0xff && (bytes[1] === 0xfb || bytes[1] === 0xf3 || bytes[1] === 0xf2)) ||
      (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)) return "audio/mpeg";
  // MP4/MOV (ftyp box)
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    if (bytes[8] === 0x71 && bytes[9] === 0x74) return "video/quicktime"; // qt
    return "video/mp4";
  }
  // WebM (Matroska)
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  // Old MS Office (doc, xls, ppt)
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return "application/msword";

  return null;
}

function isMimeMatch(detected: string, claimed: string): boolean {
  // Exact match
  if (detected === claimed) return true;

  // ZIP detected but claimed as Office XML — that's fine (docx/xlsx/pptx are ZIP-based)
  if (detected === "application/zip") {
    if (claimed.includes("word") || claimed.includes("sheet") || claimed.includes("presentation") || claimed.includes("opendocument")) {
      return true;
    }
  }

  // Office detected but claimed as generic — fine
  if (detected === "application/msword") {
    if (claimed.includes("msword") || claimed.includes("officedocument") || claimed.includes("octet-stream")) {
      return true;
    }
  }

  // WebM detected but claimed as video or audio — both use same container
  if (detected === "video/webm" && (claimed.startsWith("video/") || claimed.startsWith("audio/"))) {
    return true;
  }

  // MP4 detected but claimed as video or audio
  if (detected === "video/mp4" && (claimed.startsWith("video/") || claimed.startsWith("audio/"))) {
    return true;
  }

  // OGG detected but claimed as video or audio
  if (detected === "audio/ogg" && (claimed.startsWith("video/") || claimed.startsWith("audio/"))) {
    return true;
  }

  return false;
}

export function detectMimeType(buffer: ArrayBuffer): string | null {
  return detectMimeFromBytes(new Uint8Array(buffer));
}
