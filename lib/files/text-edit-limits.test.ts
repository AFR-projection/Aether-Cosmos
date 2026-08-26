import { describe, it, expect } from "vitest";
import {
  TEXT_EDIT_MAX_BYTES,
  clampTextForPreview,
  isTextEditable,
  textByteLength,
  withinTextEditBounds,
} from "@/lib/files/text-edit-limits";

/**
 * These bounds are the only thing standing between "edit a file in the browser" and
 * "save half a file over the whole one", so the boundaries are asserted exactly rather
 * than approximately — especially the case where a file is over the BYTE ceiling while
 * still short enough that nothing is cut from the display.
 */

describe("textByteLength", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(textByteLength("abc")).toBe(3);
    expect(textByteLength("é")).toBe(2);
    expect(textByteLength("😀")).toBe(4);
    expect(textByteLength("")).toBe(0);
  });
});

describe("withinTextEditBounds", () => {
  it("accepts a body exactly at the ceiling", () => {
    expect(withinTextEditBounds("a".repeat(TEXT_EDIT_MAX_BYTES))).toBe(true);
  });

  it("refuses one byte past the ceiling", () => {
    expect(withinTextEditBounds("a".repeat(TEXT_EDIT_MAX_BYTES + 1))).toBe(false);
  });

  it("measures multi-byte text by its bytes", () => {
    // Half as many characters as the ceiling, but two bytes each: over.
    const text = "é".repeat(TEXT_EDIT_MAX_BYTES / 2 + 1);
    expect(text.length).toBeLessThan(TEXT_EDIT_MAX_BYTES);
    expect(withinTextEditBounds(text)).toBe(false);
  });
});

describe("clampTextForPreview", () => {
  it("passes a small file through whole and editable", () => {
    const result = clampTextForPreview("hello\nworld");
    expect(result).toEqual({ text: "hello\nworld", truncated: false, editable: true });
  });

  it("treats an empty file as editable", () => {
    expect(clampTextForPreview("")).toEqual({ text: "", truncated: false, editable: true });
  });

  it("keeps a file exactly at the ceiling editable", () => {
    const text = "a".repeat(TEXT_EDIT_MAX_BYTES);
    const result = clampTextForPreview(text);
    expect(result.truncated).toBe(false);
    expect(result.editable).toBe(true);
    expect(result.text).toBe(text);
  });

  it("cuts an oversized file and refuses to edit it", () => {
    const text = "a".repeat(TEXT_EDIT_MAX_BYTES + 500);
    const result = clampTextForPreview(text);
    expect(result.editable).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(TEXT_EDIT_MAX_BYTES);
  });

  it("refuses to edit an over-ceiling file even when nothing was cut", () => {
    // Multi-byte: over the byte ceiling, but fewer characters than the ceiling, so the
    // whole file is still on screen. `truncated` must stay false — nothing is missing —
    // while `editable` must be false, because saving it back would be rejected.
    const text = "é".repeat(TEXT_EDIT_MAX_BYTES / 2 + 1);
    const result = clampTextForPreview(text);
    expect(result.text).toBe(text);
    expect(result.truncated).toBe(false);
    expect(result.editable).toBe(false);
  });
});

describe("isTextEditable", () => {
  it("accepts text and code files", () => {
    expect(isTextEditable("text/plain", "notes.txt")).toBe(true);
    expect(isTextEditable("text/markdown", "README.md")).toBe(true);
    expect(isTextEditable("application/json", "package.json")).toBe(true);
    // Recognised by extension when the browser could not name the type.
    expect(isTextEditable("application/octet-stream", "main.rs")).toBe(true);
  });

  it("accepts delimited text, which the previewer renders as characters too", () => {
    expect(isTextEditable("text/csv", "rows.csv")).toBe(true);
    expect(isTextEditable("text/plain", "rows.tsv")).toBe(true);
  });

  it("refuses SVG, which is markup that executes", () => {
    expect(isTextEditable("image/svg+xml", "logo.svg")).toBe(false);
    expect(isTextEditable("text/plain", "logo.svg")).toBe(false);
  });

  it("refuses binary and office formats", () => {
    expect(isTextEditable("application/pdf", "report.pdf")).toBe(false);
    expect(isTextEditable("image/png", "shot.png")).toBe(false);
    expect(
      isTextEditable(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "book.xlsx"
      )
    ).toBe(false);
    expect(isTextEditable("application/zip", "project.zip")).toBe(false);
  });

  it("refuses what the previewer refuses, so the editor never appears where preview cannot", () => {
    expect(isTextEditable("application/octet-stream", "setup.exe")).toBe(false);
    // A .bat is a script, but it is an executable extension first.
    expect(isTextEditable("text/plain", "run.bat")).toBe(false);
  });
});
