/**
 * Extract plain text from a Tiptap/ProseMirror JSON document.
 *
 * Tiptap stores rich text as a nested node tree: text lives in `text` fields on
 * leaf nodes, and block nodes carry `content` arrays of children. We walk the
 * tree and join all text, inserting a space at block boundaries so words from
 * adjacent paragraphs don't run together in the search index.
 *
 * Input is untrusted JSON (from the request body), so every field is checked
 * before access and the walk is depth-limited to avoid pathological nesting.
 */

type TiptapNode = {
  type?: string;
  text?: string;
  content?: unknown;
};

const MAX_DEPTH = 100;

export function tiptapToPlainText(doc: unknown, depth = 0): string {
  if (depth > MAX_DEPTH || doc == null || typeof doc !== "object") return "";

  const node = doc as TiptapNode;
  const parts: string[] = [];

  if (typeof node.text === "string") {
    parts.push(node.text);
  }

  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      const text = tiptapToPlainText(child, depth + 1);
      if (text) parts.push(text);
    }
  }

  // Join children with spaces so block boundaries become word boundaries.
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
