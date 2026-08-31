import { describe, it, expect } from "vitest";
import { tiptapToMarkdown } from "@files/domain/services/export";

const doc = (content: unknown[]) => ({ type: "doc", content });
const p = (text: string, marks?: unknown[]) => ({
  type: "paragraph",
  content: [{ type: "text", text, ...(marks ? { marks } : {}) }],
});

describe("tiptapToMarkdown", () => {
  it("returns empty string for empty / invalid input", () => {
    expect(tiptapToMarkdown(null)).toBe("");
    expect(tiptapToMarkdown({})).toBe("");
    expect(tiptapToMarkdown(doc([]))).toBe("");
  });

  it("serializes headings with the right level", () => {
    expect(
      tiptapToMarkdown(doc([{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] }]))
    ).toBe("## Title");
  });

  it("applies inline marks", () => {
    expect(tiptapToMarkdown(doc([p("hi", [{ type: "bold" }])]))).toBe("**hi**");
    expect(tiptapToMarkdown(doc([p("hi", [{ type: "italic" }])]))).toBe("*hi*");
    expect(tiptapToMarkdown(doc([p("hi", [{ type: "code" }])]))).toBe("`hi`");
    expect(
      tiptapToMarkdown(doc([p("site", [{ type: "link", attrs: { href: "https://x.com" } }])]))
    ).toBe("[site](https://x.com)");
  });

  it("serializes bullet and ordered lists", () => {
    const bullet = doc([
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [p("a")] },
          { type: "listItem", content: [p("b")] },
        ],
      },
    ]);
    expect(tiptapToMarkdown(bullet)).toBe("- a\n- b");

    const ordered = doc([
      {
        type: "orderedList",
        content: [
          { type: "listItem", content: [p("first")] },
          { type: "listItem", content: [p("second")] },
        ],
      },
    ]);
    expect(tiptapToMarkdown(ordered)).toBe("1. first\n2. second");
  });

  it("serializes task lists with checkbox state", () => {
    const tasks = doc([
      {
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { checked: true }, content: [p("done")] },
          { type: "taskItem", attrs: { checked: false }, content: [p("todo")] },
        ],
      },
    ]);
    expect(tiptapToMarkdown(tasks)).toBe("- [x] done\n- [ ] todo");
  });

  it("serializes code blocks with language", () => {
    expect(
      tiptapToMarkdown(
        doc([{ type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: "x=1" }] }])
      )
    ).toBe("```js\nx=1\n```");
  });

  it("serializes horizontal rule and hard break", () => {
    expect(tiptapToMarkdown(doc([{ type: "horizontalRule" }]))).toBe("---");
    expect(
      tiptapToMarkdown(
        doc([{ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }] }])
      )
    ).toBe("a  \nb");
  });

  it("joins multiple blocks with blank lines", () => {
    expect(tiptapToMarkdown(doc([p("one"), p("two")]))).toBe("one\n\ntwo");
  });
});
