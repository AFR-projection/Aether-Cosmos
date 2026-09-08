import type { ExactMediaState, Thumbnail } from "./media-worker-core";

export const THUMBNAIL_SIZES = [150, 300, 600, 1200] as const;

export type ThumbnailRenderDependencies = {
  loadBytes(input: ExactMediaState): Promise<Buffer>;
  extractVideoFrame(input: ExactMediaState): Promise<Buffer>;
  extractAudioCover(input: ExactMediaState): Promise<Buffer | null>;
  renderPdf(input: ExactMediaState): Promise<Buffer>;
  resizeWebp(source: Buffer, size: number, fit: "contain" | "cover"): Promise<Buffer>;
};

export function audioThumbnailPlaceholder(): Buffer {
  return Buffer.from(`<svg width="600" height="600" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#10b981"/>
      <stop offset="100%" stop-color="#06b6d4"/>
    </linearGradient></defs>
    <rect width="600" height="600" fill="#0f172a"/>
    <path d="M210 280v40M234 260v80M258 292v16M282 248v104M306 276v48M330 264v72M354 288v24M378 256v88"
      stroke="url(#g)" stroke-width="10" stroke-linecap="round"/>
    <circle cx="300" cy="390" r="34" fill="url(#g)" opacity=".75"/>
    <polygon points="290,376 290,404 318,390" fill="white"/>
  </svg>`);
}

export async function renderThumbnailSet(
  input: ExactMediaState,
  deps: ThumbnailRenderDependencies,
): Promise<Thumbnail[]> {
  let source: Buffer;
  let fit: "contain" | "cover" = "cover";
  if (input.mimeType.startsWith("video/")) {
    source = await deps.extractVideoFrame(input);
    fit = "contain";
  } else if (input.mimeType.startsWith("image/") && input.mimeType !== "image/svg+xml") {
    source = await deps.loadBytes(input);
  } else if (input.mimeType === "application/pdf") {
    source = await deps.renderPdf(input);
    fit = "contain";
  } else if (input.mimeType.startsWith("audio/")) {
    source = (await deps.extractAudioCover(input)) ?? audioThumbnailPlaceholder();
  } else {
    return [];
  }

  return Promise.all(
    THUMBNAIL_SIZES.map(async (size) => ({
      size,
      body: await deps.resizeWebp(source, size, fit),
    })),
  );
}
