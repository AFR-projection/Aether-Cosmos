export type MediaMetadata = {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrateBps: number | null;
  container: string | null;
  faststart: boolean | null;
};

type ProbeStream = {
  codec_type?: unknown;
  codec_name?: unknown;
  width?: unknown;
  height?: unknown;
  avg_frame_rate?: unknown;
  r_frame_rate?: unknown;
};

type ProbeDocument = {
  format?: {
    duration?: unknown;
    bit_rate?: unknown;
    format_name?: unknown;
  };
  streams?: unknown;
};

function finitePositive(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function integerPositive(value: unknown): number | null {
  const parsed = finitePositive(value);
  return parsed === null ? null : Math.round(parsed);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : null;
}

function frameRate(value: unknown): number | null {
  const text = stringValue(value);
  if (!text) return null;
  const [left, right] = text.split("/");
  const numerator = Number.parseFloat(left);
  const denominator = right === undefined ? 1 : Number.parseFloat(right);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return null;
  }
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function normalizeContainer(value: unknown): string | null {
  const names = stringValue(value)?.split(",") ?? [];
  if (names.includes("mp4") || names.includes("mov")) return "mp4";
  if (names.includes("webm")) return "webm";
  if (names.includes("matroska")) return "matroska";
  return names[0] || null;
}

export function buildFfprobeArgs(inputPath: string): string[] {
  return [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    inputPath,
  ];
}

export function parseMediaProbe(value: unknown): MediaMetadata {
  const document =
    value && typeof value === "object" ? (value as ProbeDocument) : {};
  const streams: ProbeStream[] = Array.isArray(document.streams)
    ? document.streams.filter((stream): stream is ProbeStream =>
        Boolean(stream && typeof stream === "object"),
      )
    : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = finitePositive(document.format?.duration);

  return {
    durationMs: duration === null ? null : Math.round(duration * 1000),
    width: integerPositive(video?.width),
    height: integerPositive(video?.height),
    fps: frameRate(video?.avg_frame_rate) ?? frameRate(video?.r_frame_rate),
    videoCodec: stringValue(video?.codec_name),
    audioCodec: stringValue(audio?.codec_name),
    bitrateBps: integerPositive(document.format?.bit_rate),
    container: normalizeContainer(document.format?.format_name),
    faststart: null,
  };
}

const MP4_BRANDS = new Set([
  "3g2a",
  "3g2b",
  "3g2c",
  "3ge6",
  "3ge7",
  "3gg6",
  "3gp4",
  "3gp5",
  "3gp6",
  "3gp7",
  "avc1",
  "dash",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "isom",
  "m4a ",
  "m4b ",
  "m4p ",
  "m4v ",
  "mp41",
  "mp42",
  "msnv",
  "ndas",
  "ndsc",
  "ndsh",
  "ndsm",
  "ndsp",
  "ndss",
  "ndxc",
  "ndxh",
  "ndxm",
  "ndxp",
  "ndxs",
]);

function hasMp4Brand(buffer: Buffer): boolean {
  if (buffer.length < 16 || buffer.toString("ascii", 4, 8) !== "ftyp")
    return false;
  const size = buffer.readUInt32BE(0);
  const limit = Math.min(buffer.length, size >= 16 ? size : buffer.length);
  for (let offset = 8; offset + 4 <= limit; offset += 4) {
    if (
      MP4_BRANDS.has(buffer.toString("ascii", offset, offset + 4).toLowerCase())
    )
      return true;
  }
  return false;
}

export function detectMp4FaststartFromAtoms(bytes: Uint8Array): boolean | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!hasMp4Brand(buffer)) return null;
  let offset = 0;
  let sawMdat = false;
  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > buffer.length) return null;
      const extended = buffer.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(extended);
      headerSize = 16;
    } else if (size === 0) {
      size = buffer.length - offset;
    }
    if (size < headerSize) return null;
    if (type === "moov") return !sawMdat;
    if (type === "mdat") sawMdat = true;
    if (offset + size > buffer.length) return null;
    offset += size;
  }
  return null;
}

export type VideoCompatibility = {
  compatible: boolean;
  reason: "container" | "video-codec" | "audio-codec" | null;
};

const DIRECT_CONTAINERS = new Set(["mp4", "webm"]);
const DIRECT_VIDEO_CODECS = new Set(["h264", "av1", "vp8", "vp9"]);
const DIRECT_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis"]);

export function classifyVideoCompatibility(
  metadata: MediaMetadata,
): VideoCompatibility {
  if (!metadata.container || !DIRECT_CONTAINERS.has(metadata.container)) {
    return { compatible: false, reason: "container" };
  }
  if (!metadata.videoCodec || !DIRECT_VIDEO_CODECS.has(metadata.videoCodec)) {
    return { compatible: false, reason: "video-codec" };
  }
  if (metadata.audioCodec && !DIRECT_AUDIO_CODECS.has(metadata.audioCodec)) {
    return { compatible: false, reason: "audio-codec" };
  }
  return { compatible: true, reason: null };
}
