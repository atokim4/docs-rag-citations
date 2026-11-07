export type Inline = { kind: "text"; text: string } | { kind: "cite"; n: number } | { kind: "code"; text: string };
export type Block = { kind: "paragraph"; parts: Inline[] } | { kind: "code"; text: string };

/**
 * Splits an answer into paragraphs and fenced code blocks, and paragraphs into text, inline
 * `code` and `[n]` citation markers. Rendering from this structure keeps model output out of
 * innerHTML.
 */
export function parseAnswer(answer: string, { citations = true } = {}): Block[] {
  const blocks: Block[] = [];
  const pieces = answer.split(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/m);
  pieces.forEach((piece, i) => {
    if (i % 2 === 1) {
      blocks.push({ kind: "code", text: piece.replace(/\n$/, "") });
      return;
    }
    for (const paragraph of piece.split(/\n{2,}/)) {
      const text = paragraph.trim();
      if (text) blocks.push({ kind: "paragraph", parts: parseInline(text, citations) });
    }
  });
  return blocks;
}

export function parseInline(text: string, citations = true): Inline[] {
  const parts: Inline[] = [];
  const pattern = citations ? /\[(\d+)\]|`([^`\n]+)`/g : /()`([^`\n]+)`/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push({ kind: "text", text: text.slice(last, match.index) });
    if (match[1]) parts.push({ kind: "cite", n: Number(match[1]) });
    else parts.push({ kind: "code", text: match[2]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}
