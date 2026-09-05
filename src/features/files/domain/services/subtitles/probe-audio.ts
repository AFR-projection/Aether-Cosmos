import { ASR_SAMPLE_RATE } from "./audio-extract";

/**
 * A throwaway audio clip for the admin "Test" button.
 *
 * The test has to answer one question — does this base URL, model and key actually work — and to
 * answer it honestly the request has to be the same shape as a real one: a multipart upload of an
 * audio file, asking for `verbose_json`. That means it needs audio, and generating a second of
 * silence in fourteen lines is cheaper and more reliable than shipping a fixture, spawning ffmpeg,
 * or (worst of all) transcribing a real user's video to find out whether the key is good.
 *
 * Silence is the right content. A provider returns `segments: []` for it, which the transcriber
 * reads as an empty transcript and not as an error — so a passing test proves the endpoint,
 * credentials and model are all correct, and a *failing* one is either an HTTP failure worth
 * quoting or a model that does not implement `verbose_json`, which is exactly the misconfiguration
 * an operator needs to hear about before a user hits it.
 *
 * A canonical 44-byte header, written by hand: this is the one place in the app that constructs a
 * media container, and `probe-audio.test.ts` checks every field against the specification rather
 * than against this code.
 */

/** One second is past every provider's minimum length and still only 32 KB. */
const PROBE_SECONDS = 1;

export function buildSilentWav(options: {
  seconds: number;
  sampleRate: number;
}): Uint8Array {
  const sampleRate = Math.max(8_000, Math.round(options.sampleRate));
  // Never zero-length: an empty file is rejected by every provider, and the failure would read as
  // a credentials problem.
  const samples = Math.max(1, Math.round(options.seconds * sampleRate));
  const bytesPerSample = 2;
  const dataBytes = samples * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataBytes);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // everything after this field
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk length
  view.setUint16(20, 1, true); // PCM, uncompressed
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  // The samples themselves are already zero — an ArrayBuffer starts that way, and zero is silence
  // in signed PCM.

  return bytes;
}

/** The clip the test route sends, built once at module load. */
export const PROBE_WAV = {
  bytes: buildSilentWav({ seconds: PROBE_SECONDS, sampleRate: ASR_SAMPLE_RATE }),
  fileName: "subtitle-provider-test.wav",
  mimeType: "audio/wav",
} as const;
