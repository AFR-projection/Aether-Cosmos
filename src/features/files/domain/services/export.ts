/**
 * Serialize a Tiptap/ProseMirror JSON document to Markdown for note export.
 *
 * Handles the node/mark set the note editor uses: headings, paragraphs, bullet
 * / ordered / task lists, blockquote, code block, horizontal rule, hard break,
 * and inline marks (bold, italic, strike, code, link). Unknown nodes fall back
 * to their text content so nothing is silently dropped.
 *
 * Input is the editor's own JSON, but we still guard every field (it may be
 * round-tripped through the DB) and depth-limit the walk.
 */

type Mark = { type?: string; attrs?: Record<string, unknown> };
type Node = {
  type?: string;
  text?: string;
  marks?: Mark[];
  attrs?: Record<string, unknown>;
  content?: unknown;
};

const MAX_DEPTH = 100;

function applyMarks(text: string, marks: Mark[] | undefined): string {
  if (!marks || marks.length === 0) return text;
  let out = text;
  for (const mark of marks) {
    switch (mark.type) {
      case "bold":
        out = `**${out}**`;
        break;
      case "italic":
        out = `*${out}*`;
        break;
      case "strike":
        out = `~~${out}~~`;
        break;
      case "code":
        out = `\`${out}\``;
        break;
      case "link": {
        const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
        out = href ? `[${out}](${href})` : out;
        break;
      }
      // highlight / textStyle color have no Markdown equivalent — keep text as-is.
    }
  }
  return out;
}

function inlineText(nodes: unknown, depth: number): string {
  if (!Array.isArray(nodes)) return "";
  let out = "";
  for (const raw of nodes) {
    if (raw == null || typeof raw !== "object") continue;
    const node = raw as Node;
    if (node.type === "hardBreak") {
      out += "  \n";
    } else if (typeof node.text === "string") {
      out += applyMarks(node.text, node.marks);
    } else if (Array.isArray(node.content)) {
      out += inlineText(node.content, depth + 1);
    }
  }
  return out;
}

function listItems(
  node: Node,
  depth: number,
  render: (child: Node, index: number) => string
): string {
  if (!Array.isArray(node.content)) return "";
  return (node.content as unknown[])
    .map((c, i) => (c && typeof c === "object" ? render(c as Node, i) : ""))
    .filter(Boolean)
    .join("\n");
}

function blockToMarkdown(node: Node, depth: number): string {
  if (depth > MAX_DEPTH) return "";

  switch (node.type) {
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      return `${"#".repeat(level)} ${inlineText(node.content, depth)}`;
    }
    case "paragraph":
      return inlineText(node.content, depth);
    case "bulletList":
      return listItems(node, depth, (item) => `- ${inlineText(itemInline(item), depth)}`);
    case "orderedList":
      return listItems(node, depth, (item, i) => `${i + 1}. ${inlineText(itemInline(item), depth)}`);
    case "taskList":
      return listItems(node, depth, (item) => {
        const checked = item.attrs?.checked === true;
        return `- [${checked ? "x" : " "}] ${inlineText(itemInline(item), depth)}`;
      });
    case "blockquote":
      return `> ${childBlocks(node, depth).replace(/\n/g, "\n> ")}`;
    case "codeBlock": {
      const lang = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      return `\`\`\`${lang}\n${inlineText(node.content, depth)}\n\`\`\``;
    }
    case "horizontalRule":
      return "---";
    default:
      // Fallback: render children as blocks, or inline text.
      if (Array.isArray(node.content)) return childBlocks(node, depth);
      return "";
  }
}

/** A list item's inner paragraph content flattened to one inline run. */
function itemInline(item: Node): unknown {
  if (!Array.isArray(item.content)) return [];
  const parts: unknown[] = [];
  for (const block of item.content) {
    if (block && typeof block === "object" && Array.isArray((block as Node).content)) {
      parts.push(...((block as Node).content as unknown[]));
    }
  }
  return parts;
}

function childBlocks(node: Node, depth: number): string {
  if (!Array.isArray(node.content)) return "";
  return (node.content as unknown[])
    .map((c) => (c && typeof c === "object" ? blockToMarkdown(c as Node, depth + 1) : ""))
    .filter((s) => s !== "")
    .join("\n\n");
}

/** Convert a Tiptap JSON doc to a Markdown string. */
export function tiptapToMarkdown(doc: unknown): string {
  if (doc == null || typeof doc !== "object") return "";
  const root = doc as Node;
  if (!Array.isArray(root.content)) return "";
  return root.content
    .map((c) => (c && typeof c === "object" ? blockToMarkdown(c as Node, 0) : ""))
    .filter((s) => s !== "")
    .join("\n\n")
    .trim();
}
