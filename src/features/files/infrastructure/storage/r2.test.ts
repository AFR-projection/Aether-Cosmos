import { describe, it, expect } from "vitest";
import { encodeContentDispositionFilename } from "@files/infrastructure/storage/r2";

describe("encodeContentDispositionFilename", () => {
  it("emits both filename and RFC 5987 filename* parts", () => {
    const out = encodeContentDispositionFilename("photo.jpg");
    expect(out).toContain('filename="photo.jpg"');
    expect(out).toContain("filename*=UTF-8''photo.jpg");
  });

  it("preserves unicode names in the filename* part", () => {
    const out = encodeContentDispositionFilename("laporan café.pdf");
    // ASCII fallback keeps spaces (valid in quoted value) but replaces é.
    expect(out).toContain('filename="laporan caf_.pdf"');
    // filename* keeps the real name percent-encoded.
    expect(out).toContain("filename*=UTF-8''laporan%20caf%C3%A9.pdf");
  });

  it("neutralizes double quotes so the header cannot be broken out of", () => {
    const out = encodeContentDispositionFilename('evil".pdf');
    const start = out.indexOf('filename="') + 'filename="'.length;
    const asciiPart = out.slice(start, out.indexOf('";'));
    expect(asciiPart).not.toContain('"');
  });

  it("strips path separators from the ASCII fallback", () => {
    const out = encodeContentDispositionFilename("a/b\\c.txt");
    expect(out).toContain('filename="a_b_c.txt"');
  });

  it("replaces newline/control characters", () => {
    const out = encodeContentDispositionFilename("bad\nname.txt");
    expect(out).toContain('filename="bad_name.txt"');
  });
});
