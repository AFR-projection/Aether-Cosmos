import { describe, it, expect } from "vitest";
import { PROBE_WAV, buildSilentWav } from "@files/domain/services/subtitles/probe-audio";

/**
 * The throwaway clip the admin "Test" button sends.
 *
 * A byte layout is exactly the kind of thing to pin: a wrong field in a WAV header does not throw,
 * it makes a provider answer "unsupported file" and an operator conclude their key is bad. The
 * numbers below are read off the RIFF/WAVE specification rather than off the implementation.
 */

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.slice(at, at + length));

describe("buildSilentWav", () => {
  const wav = buildSilentWav({ seconds: 1, sampleRate: 16_000 });

  it("is a RIFF/WAVE file", () => {
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    expect(ascii(wav, 36, 4)).toBe("data");
  });

  it("is exactly the header plus the samples", () => {
    // 44-byte canonical header, then one second of 16-bit mono at 16 kHz.
    expect(wav.byteLength).toBe(44 + 16_000 * 2);
  });

  it("declares the sizes the specification puts in the two size fields", () => {
    const data = view(wav);
    expect(data.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(data.getUint32(40, true)).toBe(wav.byteLength - 44);
  });

  it("declares uncompressed 16-bit mono at the sample rate it was given", () => {
    const data = view(wav);
    expect(data.getUint16(20, true)).toBe(1); // PCM
    expect(data.getUint16(22, true)).toBe(1); // mono
    expect(data.getUint32(24, true)).toBe(16_000); // sample rate
    expect(data.getUint32(28, true)).toBe(16_000 * 2); // byte rate
    expect(data.getUint16(32, true)).toBe(2); // block align
    expect(data.getUint16(34, true)).toBe(16); // bits per sample
  });

  it("is silent", () => {
    expect(wav.slice(44).every((byte) => byte === 0)).toBe(true);
  });

  it("refuses to produce a zero-length clip, which every provider rejects", () => {
    expect(buildSilentWav({ seconds: 0, sampleRate: 16_000 }).byteLength).toBeGreaterThan(44);
  });
});

describe("PROBE_WAV", () => {
  it("is long enough that no provider rejects it for being too short", () => {
    expect(PROBE_WAV.bytes.byteLength).toBeGreaterThanOrEqual(44 + 16_000 * 2);
  });

  it("names itself as a wav, since the provider reads the container from the filename", () => {
    expect(PROBE_WAV.fileName.endsWith(".wav")).toBe(true);
    expect(PROBE_WAV.mimeType).toBe("audio/wav");
  });
});
