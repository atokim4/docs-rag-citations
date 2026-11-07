import type { Source } from "../types.js";

/** Sentence both engines use when the sources do not contain the answer. */
export const REFUSAL = "I don't know based on the provided documents.";

/**
 * Finds the `[n]` markers in an answer that point at real sources (in order of first use) and
 * removes the ones that do not, so the UI never shows a dead citation. `[1, 2]` and `[1][2]`
 * both work.
 */
export function resolveCitations(text: string, sourceCount: number): { text: string; cited: number[] } {
  const cited: number[] = [];
  const cleaned = text.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, group: string) => {
    const valid = group
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= sourceCount);
    for (const n of valid) if (!cited.includes(n)) cited.push(n);
    return valid.map((n) => `[${n}]`).join("");
  });
  return { text: tidyProse(cleaned).trim(), cited };
}

/** Removes the gaps a dropped marker leaves ("word [9]." -> "word."), leaving code blocks alone. */
function tidyProse(text: string): string {
  return text
    .split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/m)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/[ \t]+([.,;:])/g, "$1").replace(/[ \t]{2,}/g, " ")))
    .join("");
}

/** True when the answer is the refusal sentence (allowing small wording or punctuation drift). */
export function isRefusal(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
  return normalized.startsWith("i don't know") || normalized.startsWith("i do not know");
}

/** Where a source comes from, e.g. `guides/rpc.md > RPC > Client, p. 3`. */
export function sourceLabel(source: Pick<Source, "documentName" | "headings" | "page">): string {
  const parts = [source.documentName];
  if (source.headings.length > 0) parts.push(source.headings.join(" > "));
  const label = parts.join(" > ");
  return source.page ? `${label}, p. ${source.page}` : label;
}
