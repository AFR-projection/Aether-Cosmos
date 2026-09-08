import { describe, expect, it } from "vitest";
import {
  buildFfprobeArgs,
  classifyVideoCompatibility,
  detectMp4FaststartFromAtoms,
  parseMediaProbe,
} from "./media-metadata";

const probe = (overrides: Record<string, unknown> = {}) => ({
  format: {
    duration: "125.456",
    bit_rate: "4500000",
    format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    tags: { major_brand: "isom" },
  },
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      width: 1920,
      height: 1080,
      avg_frame_rate: "30000/1001",
    },
    { codec_type: "audio", codec_name: "aac" },
  ],
  ...overrides,
});

describe("buildFfprobeArgs", () => {
  it("requests JSON stream and format data without shell parsing", () => {
    const args = buildFfprobeArgs("/tmp/video.mp4");
    expect(args).toContain("-show_streams");
    expect(args).toContain("-show_format");
    expect(args).not.toContain("-show_packets");
    expect(args[args.length - 1]).toBe("/tmp/video.mp4");
  });
});

describe("parseMediaProbe", () => {
  it("normalizes video metadata and detects an MP4 moov atom before media packets", () => {
    const result = parseMediaProbe(probe());

    expect(result).toEqual({
      durationMs: 125456,
      width: 1920,
      height: 1080,
      fps: 29.97,
      videoCodec: "h264",
      audioCodec: "aac",
      bitrateBps: 4500000,
      container: "mp4",
      faststart: null,
    });
  });

  it("detects MP4 faststart from atom order rather than packet heuristics", () => {
    const atom = (name: string, bodyLength = 0, body?: string) => {
      const result = Buffer.alloc(8 + bodyLength);
      result.writeUInt32BE(result.length, 0);
      result.write(name, 4, 4, "ascii");
      if (body)
        result.write(body, 8, Math.min(body.length, bodyLength), "ascii");
      return result;
    };
    const ftyp = atom("ftyp", 8, "isomiso2");
    expect(
      detectMp4FaststartFromAtoms(
        Buffer.concat([ftyp, atom("moov"), atom("mdat", 4)]),
      ),
    ).toBe(true);
    expect(
      detectMp4FaststartFromAtoms(
        Buffer.concat([ftyp, atom("mdat", 4), atom("moov")]),
      ),
    ).toBe(false);
    expect(detectMp4FaststartFromAtoms(ftyp)).toBeNull();
  });

  it("uses nulls for malformed or missing optional values", () => {
    const result = parseMediaProbe({
      format: { duration: "N/A", bit_rate: "", format_name: "matroska,webm" },
      streams: [
        {
          codec_type: "video",
          codec_name: "vp9",
          width: 0,
          avg_frame_rate: "0/0",
        },
      ],
    });
    expect(result).toEqual({
      durationMs: null,
      width: null,
      height: null,
      fps: null,
      videoCodec: "vp9",
      audioCodec: null,
      bitrateBps: null,
      container: "webm",
      faststart: null,
    });
  });
});

describe("classifyVideoCompatibility", () => {
  it("marks ordinary H.264/AAC MP4 as direct-compatible", () => {
    const metadata = parseMediaProbe(probe());
    expect(classifyVideoCompatibility(metadata)).toEqual({
      compatible: true,
      reason: null,
    });
  });

  it("explains codec and container incompatibility without rejecting storage", () => {
    expect(
      classifyVideoCompatibility({
        durationMs: 1000,
        width: 1920,
        height: 1080,
        fps: 24,
        videoCodec: "hevc",
        audioCodec: "ac3",
        bitrateBps: 1,
        container: "matroska",
        faststart: null,
      }),
    ).toEqual({ compatible: false, reason: "container" });
  });
});
