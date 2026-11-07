import { splitSentences } from "../ingest/chunker.js";
import type { Source } from "../types.js";
import type { Answerer, DraftAnswer } from "./answerer.js";
import { REFUSAL } from "./citations.js";

export interface ExtractiveOptions {
  /** Share of the question's (IDF-weighted) terms a passage must contain to be used. */
  minCoverage: number;
  /** Most sources to quote from. */
  maxSources: number;
  /** Rough length cap for the whole answer, in words. */
  maxWords: number;
}

export const DEFAULT_EXTRACTIVE_OPTIONS: ExtractiveOptions = { minCoverage: 0.4, maxSources: 2, maxWords: 120 };

/** Terms from the heading trail count this much, so "Path parameters" helps its paragraphs. */
const HEADING_WEIGHT = 0.5;
/** Terms found elsewhere in the same chunk count a little: the passage is in the right place. */
const CONTEXT_WEIGHT = 0.25;
/** How much less coverage a second quoted source may have than the best passage. */
const SECOND_SOURCE_MARGIN = 0.15;
/** Prose paragraphs longer than this are split into sentences before scoring. */
const LONG_PASSAGE_WORDS = 70;

interface Block {
  text: string;
  code: boolean;
}

interface Passage extends Block {
  n: number;
  terms: Set<string>;
  headingTerms: Set<string>;
  sourceTerms: Set<string>;
  /** Index inside its source, used to find the code sample after a passage. */
  position: number;
  /** Index inside the whole source list (sources come in retrieval order). */
  order: number;
}

/**
 * Answers without a language model: quotes the source passages that cover most of the
 * question's terms, each with its citation, and keeps a code sample together with the line
 * that introduces it. Deterministic, free and offline, so the app and the eval run without an
 * API key. It cannot paraphrase or combine facts the way an LLM can.
 */
export class ExtractiveAnswerer implements Answerer {
  readonly engine = "extractive";
  readonly model = null;
  private readonly options: ExtractiveOptions;

  constructor(options: Partial<ExtractiveOptions> = {}) {
    this.options = { ...DEFAULT_EXTRACTIVE_OPTIONS, ...options };
  }

  answer(question: string, sources: Source[]): Promise<DraftAnswer> {
    return Promise.resolve({ text: this.compose(question, sources) });
  }

  private compose(question: string, sources: Source[]): string {
    const queryTerms = [...new Set(terms(question))];
    const passages = sources.flatMap(passagesOf).map((p, order) => ({ ...p, order }));
    if (queryTerms.length === 0 || passages.length === 0) return REFUSAL;

    const weight = idfWeights(queryTerms, passages);
    const total = queryTerms.reduce((sum, t) => sum + weight.get(t)!, 0);
    const coverage = (p: Passage): number =>
      queryTerms.reduce((sum, t) => {
        const w = weight.get(t)!;
        if (p.terms.has(t)) return sum + w;
        if (p.headingTerms.has(t)) return sum + w * HEADING_WEIGHT;
        return sum + (p.sourceTerms.has(t) ? w * CONTEXT_WEIGHT : 0);
      }, 0) / total;

    const ranked = passages
      .map((passage) => ({ passage, coverage: coverage(passage) }))
      .filter((r) => r.coverage >= this.options.minCoverage)
      // Coverage first, then a small edge for better retrieved sources and for prose.
      .map((r) => ({ ...r, score: r.coverage + 0.1 / r.passage.n + (r.passage.code ? 0 : 0.02) }))
      .sort((a, b) => b.score - a.score || a.passage.order - b.passage.order);
    if (ranked.length === 0) return REFUSAL;

    const picked: Passage[] = [];
    let words = 0;
    const best = ranked[0]!.coverage;
    for (const { passage, coverage } of ranked) {
      // Quote another source only when it covers the question about as well as the best one.
      if (picked.length > 0 && coverage < best - SECOND_SOURCE_MARGIN) break;
      const usedSources = new Set(picked.map((p) => p.n));
      if (usedSources.has(passage.n)) continue;
      if (usedSources.size >= this.options.maxSources) break;
      const partner = companion(passages, passage);
      const group = partner ? [passage, partner] : [passage];
      const length = group.reduce((sum, p) => sum + wordCount(p.text), 0);
      if (picked.length > 0 && words + length > this.options.maxWords) continue;
      picked.push(...group);
      words += length;
    }
    picked.sort((a, b) => a.order - b.order);
    return render(picked);
  }
}

function passagesOf(source: Source): Omit<Passage, "order">[] {
  const headingTerms = new Set(source.headings.flatMap(terms));
  const sourceTerms = new Set(terms(source.content));
  const blocks = blocksOf(source.content).flatMap((block): Block[] => {
    if (block.code || wordCount(block.text) <= LONG_PASSAGE_WORDS || isList(block.text)) return [block];
    return splitSentences(block.text.replace(/\n/g, " ")).map((text) => ({ text, code: false }));
  });
  return blocks.map((block, position) => ({
    ...block,
    n: source.n,
    terms: new Set(terms(block.text)),
    headingTerms,
    sourceTerms,
    position,
  }));
}

const FENCE_LINE = /^\s*(```|~~~)/;
const CODE_LINE = /[{};,(]\s*$|^\s*(\/\/|import |export |const |let |await |return |[})\]])|=>/;

/**
 * Splits chunk text into prose paragraphs and code blocks. A chunk can start or end inside a
 * fenced block (chunks overlap and split on blank lines), so fences are tracked line by line
 * and unfenced paragraphs that read like code count as code too. Fence lines are dropped;
 * `render` puts code back in a fence.
 */
export function blocksOf(content: string): Block[] {
  const lines = content.split("\n");
  const fenceCount = lines.filter((l) => FENCE_LINE.test(l)).length;
  const firstFence = lines.findIndex((l) => FENCE_LINE.test(l));
  // An odd number of fences means one was cut off. If the text before the first fence reads
  // like code, the chunk started inside a block; otherwise it ends inside one.
  let inFence = fenceCount % 2 === 1 && firstFence > 0 && looksLikeCode(lines.slice(0, firstFence).join("\n"));

  const blocks: Block[] = [];
  let buffer: string[] = [];
  let bufferIsCode = inFence;
  const flush = (): void => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!/\w/.test(text)) return;
    const code = bufferIsCode || looksLikeCode(text);
    const last = blocks[blocks.length - 1];
    if (code && last?.code) last.text += `\n\n${text}`;
    else blocks.push({ text, code });
  };

  for (const line of lines) {
    if (FENCE_LINE.test(line)) {
      flush();
      inFence = !inFence;
      bufferIsCode = inFence;
    } else if (!inFence && line.trim() === "") {
      flush();
      bufferIsCode = false;
    } else {
      buffer.push(line);
    }
  }
  flush();
  return blocks;
}

function looksLikeCode(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.length > 0 && lines.filter((l) => CODE_LINE.test(l)).length / lines.length >= 0.5;
}

/** The code sample a passage introduces ("...like this:"), or the short prose line before code. */
function companion(passages: Passage[], passage: Passage): Passage | undefined {
  const at = (position: number): Passage | undefined =>
    passages.find((p) => p.n === passage.n && p.position === position);
  if (passage.code) {
    const before = at(passage.position - 1);
    return before && !before.code && wordCount(before.text) <= 40 ? before : undefined;
  }
  const next = at(passage.position + 1);
  return next?.code && /:\s*$/.test(passage.text) ? next : undefined;
}

/** Code goes in a fence; the last passage from each source carries its citation. */
function render(passages: Passage[]): string {
  return passages
    .map((p, i) => {
      const text = p.code ? `\`\`\`\n${p.text}\n\`\`\`` : p.text;
      if (passages[i + 1]?.n === p.n) return text;
      return p.code ? `${text}\n[${p.n}]` : `${text} [${p.n}]`;
    })
    .join("\n\n");
}

const isList = (text: string): boolean => /^([-*+]|\d+\.)\s/m.test(text);
const wordCount = (text: string): number => (text.match(/\S+/g) ?? []).length;

function idfWeights(queryTerms: string[], passages: Passage[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const term of queryTerms) {
    const df = passages.filter((p) => p.terms.has(term) || p.headingTerms.has(term)).length;
    weights.set(term, Math.log(1 + passages.length / (1 + df)));
  }
  return weights;
}

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could do does did for from has have how i if in into is it its " +
    "me my of on or our should so that the their them then there these this to use used using was we what " +
    "when where which who why will with would you your about any some also not no than via"
  ).split(" "),
);

/** Lower-cased, stop-word-free, lightly stemmed word tokens. */
export function terms(text: string): string[] {
  // Split camelCase first so `setCookie` matches "set" and "cookie".
  const words = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return (words.match(/[a-z0-9_]+/g) ?? []).filter((w) => w.length > 1 && !STOPWORDS.has(w)).map(stem);
}

/** A tiny suffix stripper; enough to match "routes"/"routing"/"routed" with "route". */
export function stem(word: string): string {
  if (word.length <= 4) return word;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      if (suffix === "s" && word.endsWith("ss")) return word;
      return word.slice(0, -suffix.length).replace(/e$/, "");
    }
  }
  return word.replace(/e$/, "");
}
