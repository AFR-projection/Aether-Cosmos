import { describe, it, expect } from "vitest";
import {
  ASR_AUDIO_TARGETS,
  ASR_CHUNK_SECONDS,
  ASR_SAMPLE_RATE,
  buildSubtitleAudioArgs,
  chunkName,
  chunkPattern,
  parseSegmentList,
} from "@files/domain/services/subtitles/audio-extract";

/**
 * The one ffmpeg call this feature makes, and the file it writes about itself.
 *
 * Two things are being bought here and both are load-bearing. The first is size: speech
 * recognition resamples to 16 kHz mono whatever it is given, so sending anything richer is
 * upload time spent on samples the model throws away. The second is the segment list —
 * `-segment_list` makes ffmpeg write down where each chunk really starts and ends, which is the
 * only honest way to know: segment boundaries land on packet boundaries, so a chunk asked to be
 * 600 seconds is 600.02, and assuming otherwise drifts a little further out of sync with every
 * chunk of a long film.
 *
 * It also means no `ffprobe` call is needed at all — one process produces both the audio and
 * the timeline, so there is no second binary whose presence in the image has to be true.
 */

describe("ASR_AUDIO_TARGETS", () => {
  it("tries Opus first, because that is the one that keeps a long film small", () => {
    expect(ASR_AUDIO_TARGETS[0].encoder).toBe("libopus");
  });

  it("offers a fallback for a build without the first encoder", () => {
    expect(ASR_AUDIO_TARGETS.length).toBeGreaterThan(1);
  });

  it("only names containers an OpenAI-compatible transcription endpoint accepts", () => {
    const accepted = new Set([".ogg", ".mp3", ".m4a", ".wav", ".flac", ".webm"]);
    for (const target of ASR_AUDIO_TARGETS) {
      expect(accepted.has(target.extension), target.extension).toBe(true);
      expect(target.mimeType).toMatch(/^audio\//);
    }
  });

  it("gives every target a distinct container, so a fallback is a real second attempt", () => {
    const extensions = ASR_AUDIO_TARGETS.map((target) => target.extension);
    expect(new Set(extensions).size).toBe(extensions.length);
  });
});

describe("buildSubtitleAudioArgs", () => {
  const args = buildSubtitleAudioArgs({
    inputPath: "/tmp/in.mkv",
    outputPattern: "/tmp/out-%03d.ogg",
    listPath: "/tmp/out.csv",
    target: ASR_AUDIO_TARGETS[0],
  });
  const flag = (name: string) => args[args.indexOf(name) + 1];

  it("takes one audio track and drops everything else", () => {
    expect(args).toContain("-vn");
    expect(args).toContain("-sn");
    expect(args).toContain("-dn");
    expect(flag("-map")).toBe("0:a:0");
  });

  it("downmixes to the mono 16 kHz the model works in anyway", () => {
    expect(flag("-ac")).toBe("1");
    expect(flag("-ar")).toBe(String(ASR_SAMPLE_RATE));
  });

  it("asks for the encoder and the flags that belong to it", () => {
    expect(flag("-c:a")).toBe("libopus");
    expect(args.join(" ")).toContain(ASR_AUDIO_TARGETS[0].encoderArgs.join(" "));
  });

  it("segments the audio and writes down where each segment landed", () => {
    expect(flag("-f")).toBe("segment");
    expect(flag("-segment_time")).toBe(String(ASR_CHUNK_SECONDS));
    expect(flag("-segment_list")).toBe("/tmp/out.csv");
    expect(flag("-segment_list_type")).toBe("csv");
  });

  it("restarts each segment's clock, since each one is transcribed on its own", () => {
    expect(flag("-reset_timestamps")).toBe("1");
  });

  it("puts the input path after -i and the pattern last", () => {
    expect(flag("-i")).toBe("/tmp/in.mkv");
    expect(args[args.length - 1]).toBe("/tmp/out-%03d.ogg");
  });

  it("passes every path as its own argument, never interpolated into a string", () => {
    // execFile takes an argv array, so a filename holding a space or a quote is inert. This
    // pins that the builder never hands back a pre-joined command line.
    const shellish = buildSubtitleAudioArgs({
      inputPath: "/tmp/a b; rm -rf /.mkv",
      outputPattern: "/tmp/out-%03d.ogg",
      listPath: "/tmp/out.csv",
      target: ASR_AUDIO_TARGETS[0],
    });
    expect(shellish).toContain("/tmp/a b; rm -rf /.mkv");
  });

  it("honours a shorter chunk length when one is asked for", () => {
    const short = buildSubtitleAudioArgs({
      inputPath: "/tmp/in.mkv",
      outputPattern: "/tmp/out-%03d.ogg",
      listPath: "/tmp/out.csv",
      target: ASR_AUDIO_TARGETS[0],
      chunkSeconds: 120,
    });
    expect(short[short.indexOf("-segment_time") + 1]).toBe("120");
  });
});

describe("parseSegmentList", () => {
  it("reads the file, start and end of every segment", () => {
    const parsed = parseSegmentList(
      "out-000.ogg,0.000000,600.020000\nout-001.ogg,600.020000,1200.050000\n"
    );
    expect(parsed).toEqual([
      { file: "out-000.ogg", startSeconds: 0, endSeconds: 600.02 },
      { file: "out-001.ogg", startSeconds: 600.02, endSeconds: 1200.05 },
    ]);
  });

  it("keeps the real boundary rather than the one that was asked for", () => {
    // The whole reason this file is read instead of assumed: 600.02, not 600.
    const [first] = parseSegmentList("out-000.ogg,0.000000,600.020000\n");
    expect(first.endSeconds).not.toBe(600);
  });

  it("handles a bare filename with no directory and CRLF endings", () => {
    const parsed = parseSegmentList("a.ogg,0.000000,10.500000\r\nb.ogg,10.500000,20.000000\r\n");
    expect(parsed.map((segment) => segment.file)).toEqual(["a.ogg", "b.ogg"]);
  });

  it("skips a line that is not a segment record", () => {
    const parsed = parseSegmentList("\nout-000.ogg,0.000000,10.000000\ngarbage\n");
    expect(parsed).toHaveLength(1);
  });

  it("returns nothing for an empty list rather than throwing", () => {
    expect(parseSegmentList("")).toEqual([]);
    expect(parseSegmentList("\n\n")).toEqual([]);
  });
});

describe("chunkPattern and chunkName", () => {
  /**
   * These two have to agree, and the reason is worth stating: ffmpeg's manifest records the
   * filename it produced, but whether that is an absolute path or a bare name depends on the
   * pattern it was given. Rather than parse it back, the worker reconstructs each chunk's path
   * from its index — which is only safe while the reconstruction matches the pattern exactly.
   */
  it("produces the name the pattern would produce for that index", () => {
    const pattern = chunkPattern("/tmp/track-7", ".ogg");
    expect(pattern).toBe("/tmp/track-7-%04d.ogg");
    expect(chunkName("/tmp/track-7", 0, ".ogg")).toBe("/tmp/track-7-0000.ogg");
    expect(chunkName("/tmp/track-7", 1, ".ogg")).toBe("/tmp/track-7-0001.ogg");
    expect(chunkName("/tmp/track-7", 42, ".ogg")).toBe("/tmp/track-7-0042.ogg");
  });

  it("keeps counting past the padding rather than truncating", () => {
    // A six-hour film at ten minutes a chunk is 36 chunks, so this is headroom — but a pattern
    // that wrapped would silently overwrite chunk 0.
    expect(chunkName("/tmp/x", 12345, ".mp3")).toBe("/tmp/x-12345.mp3");
  });
});
