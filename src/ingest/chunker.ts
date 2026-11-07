import type { Chunk, Section } from "../types.js";

export interface ChunkOptions {
  /** Upper bound on words per chunk. MiniLM truncates at 256 word pieces, so stay well under. */
  maxWords: number;
  /** Words repeated from the end of one chunk at the start of the next. */
  overlapWords: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxWords: 160, overlapWords: 32 };

const countWords = (text: string): number => (text.match(/\S+/g) ?? []).length;

/**
 * Splits sections into overlapping chunks. Chunks never cross a section boundary, so each
 * one keeps a single heading trail and page number for its citation.
 */
export function chunkSections(sections: Section[], options: Partial<ChunkOptions> = {}): Chunk[] {
  const opts = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  if (opts.maxWords < 1) throw new RangeError("maxWords must be at least 1");
  if (opts.overlapWords < 0 || opts.overlapWords >= opts.maxWords) {
    throw new RangeError("overlapWords must be between 0 and maxWords - 1");
  }

  const chunks: Chunk[] = [];
  for (const section of sections) {
    for (const content of chunkText(section.text, opts)) {
      chunks.push({ index: chunks.length, headings: section.headings, page: section.page, content });
    }
  }
  return chunks;
}

/** Packs paragraphs (or sentences, or word runs when those are too long) into windows. */
export function chunkText(text: string, { maxWords, overlapWords }: ChunkOptions): string[] {
  const units = splitUnits(text, maxWords);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  for (const unit of units) {
    const words = countWords(unit);
    if (currentWords + words > maxWords && current.length > 0) {
      chunks.push(current.join("\n\n"));
      current = overlapTail(current, overlapWords);
      currentWords = current.reduce((n, u) => n + countWords(u), 0);
      // The carried tail plus this unit can still be too long; drop the tail then.
      if (currentWords + words > maxWords) {
        current = [];
        currentWords = 0;
      }
    }
    current.push(unit);
    currentWords += words;
  }
  if (current.length > 0) chunks.push(current.join("\n\n"));
  return chunks;
}

/** The last words of a chunk, as whole units where possible, to start the next one. */
function overlapTail(units: string[], overlapWords: number): string[] {
  if (overlapWords === 0) return [];
  const tail: string[] = [];
  let words = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    const n = countWords(units[i]!);
    if (words + n > overlapWords) break;
    tail.unshift(units[i]!);
    words += n;
  }
  if (tail.length > 0) return tail;
  const lastWords = units[units.length - 1]!.split(/\s+/);
  return [lastWords.slice(-overlapWords).join(" ")];
}

function splitUnits(text: string, maxWords: number): string[] {
  const units: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    if (countWords(trimmed) <= maxWords) {
      units.push(trimmed);
      continue;
    }
    for (const sentence of splitSentences(trimmed)) {
      if (countWords(sentence) <= maxWords) units.push(sentence);
      else units.push(...splitWords(sentence, maxWords));
    }
  }
  return units;
}

export function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(`])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitWords(text: string, maxWords: number): string[] {
  const words = text.split(/\s+/);
  const parts: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) parts.push(words.slice(i, i + maxWords).join(" "));
  return parts;
}

/** Text that gets embedded: the heading trail gives short chunks the context they lack. */
export function embeddingInput(chunk: Pick<Chunk, "headings" | "content">): string {
  return chunk.headings.length > 0 ? `${chunk.headings.join(" > ")}\n${chunk.content}` : chunk.content;
}
