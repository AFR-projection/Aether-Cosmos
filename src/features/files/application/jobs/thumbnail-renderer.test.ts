import { describe, expect, it } from "vitest";
import {
  audioThumbnailPlaceholder,
  renderThumbnailSet,
  type ThumbnailRenderDependencies,
} from "./thumbnail-renderer";

const exactAudio = {
  fileId: "00000000-0000-4000-8000-000000000001",
  r2Key: "users/u/song.mp3",
  mimeType: "audio/mpeg",
  version: 3,
};

describe("thumbnail renderer", () => {
  it("uses embedded audio cover art when ffmpeg extracts one", async () => {
    const deps: ThumbnailRenderDependencies = {
      loadBytes: async () => Buffer.from("audio"),
      extractVideoFrame: async () => Buffer.from("video"),
      extractAudioCover: async () => Buffer.from("cover"),
      renderPdf: async () => Buffer.from("pdf"),
      resizeWebp: async (source, size) => Buffer.from(`${source.toString()}:${size}`),
    };
    const thumbnails = await renderThumbnailSet(exactAudio, deps);
    expect(thumbnails).toHaveLength(4);
    expect(thumbnails[0].body.toString()).toBe("cover:150");
  });

  it("generates a privacy-safe audio placeholder when no cover exists", async () => {
    const deps: ThumbnailRenderDependencies = {
      loadBytes: async () => Buffer.from("audio"),
      extractVideoFrame: async () => Buffer.from("video"),
      extractAudioCover: async () => null,
      renderPdf: async () => Buffer.from("pdf"),
      resizeWebp: async (source, size) => Buffer.from(`${source.toString().includes("<svg")}:${size}`),
    };
    const thumbnails = await renderThumbnailSet(exactAudio, deps);
    expect(thumbnails[0].body.toString()).toBe("true:150");
    expect(audioThumbnailPlaceholder().toString()).not.toContain(exactAudio.r2Key);
  });
});
