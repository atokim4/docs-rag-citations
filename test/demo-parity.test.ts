/**
 * Retrieval parity between the server and the browser demo. The server indexes the Hono docs
 * with `DocsLibrary.ingest`; the demo loads the same docs from the precomputed corpus files
 * (build-corpus -> Float32 encode -> decode -> importCorpus). Both must return the same top 5
 * for every eval question in every search mode, and the hybrid ranks must match the committed
 * eval report.
 *
 * Uses the real MiniLM model, so this is the slowest test (about a minute and a half).
 */
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { markdownFiles } from "../eval/corpus.js";
import { ExtractiveAnswerer } from "../src/answer/extractive.js";
import { LocalEmbedder, type Embedder } from "../src/embedder.js";
import { DocsLibrary } from "../src/library.js";
import { Store } from "../src/store.js";
import type { SearchMode } from "../src/types.js";
import { CORPUS_DIR, CORPUS_PREFIX, buildCorpus, readEvalSummary } from "../web-demo/scripts/build-corpus.js";
import { decodeCorpus, importCorpus } from "../web-demo/src/corpus.js";

interface Question {
  id: string;
  question: string;
  gold?: { document: string; evidence: string }[];
}

interface EvalReport {
  retrieval: { mode: SearchMode; ranks: Record<string, number | null> }[];
}

/**
 * Embeds each distinct batch once. MiniLM is deterministic, so this only saves the second
 * pass over 854 chunks; both libraries still get the model's real vectors.
 */
class MemoEmbedder implements Embedder {
  private readonly cache = new Map<string, Promise<number[][]>>();
  constructor(private readonly inner: Embedder) {}
  get model(): string {
    return this.inner.model;
  }
  get dimensions(): number {
    return this.inner.dimensions;
  }
  embed(texts: string[]): Promise<number[][]> {
    const key = JSON.stringify(texts);
    let vectors = this.cache.get(key);
    if (!vectors) this.cache.set(key, (vectors = this.inner.embed(texts)));
    return vectors;
  }
}

const embedder = new MemoEmbedder(new LocalEmbedder());
const answerer = new ExtractiveAnswerer();
let server: DocsLibrary;
let demo: DocsLibrary;
let questions: Question[];
let report: EvalReport;

beforeAll(async () => {
  const dataset = JSON.parse(await readFile(join(import.meta.dirname, "..", "eval", "questions.json"), "utf8")) as {
    questions: Question[];
  };
  questions = dataset.questions;
  report = JSON.parse(await readFile(join(import.meta.dirname, "..", "eval", "results.json"), "utf8")) as EvalReport;

  server = await DocsLibrary.open({ embedder, answerer });
  for (const file of await markdownFiles(CORPUS_DIR)) {
    await server.ingest(CORPUS_PREFIX + relative(CORPUS_DIR, file), await readFile(file));
  }

  const { manifest, embeddings } = await buildCorpus(embedder, await readEvalSummary());
  // Through JSON and raw bytes, exactly as the browser fetches them.
  const parsed = JSON.parse(JSON.stringify(manifest)) as unknown;
  const store = await Store.open({ dimensions: manifest.dimensions, model: manifest.model });
  await importCorpus(store, manifest, decodeCorpus(parsed, embeddings.slice().buffer));
  demo = DocsLibrary.fromStore(store, { embedder, answerer });
}, 300_000);

afterAll(async () => {
  await server?.close();
  await demo?.close();
});

const top5 = async (library: DocsLibrary, question: string, mode: SearchMode): Promise<string[]> =>
  (await library.search(question, { mode, limit: 5 })).map((h) => `${h.documentName}#${h.chunkIndex}`);

describe("browser demo corpus vs server ingest", () => {
  it("holds the same documents and chunks", async () => {
    const shape = async (library: DocsLibrary) =>
      (await library.listDocuments()).map((d) => [d.name, d.chunkCount]);
    expect(await shape(demo)).toEqual(await shape(server));
    expect(await shape(demo)).toHaveLength(91);
  });

  it.each(["hybrid", "vector", "fulltext"] as const)("returns the same top 5 for all 30 questions (%s)", async (mode) => {
    for (const q of questions) {
      expect(await top5(demo, q.question, mode), `${q.id} (${mode})`).toEqual(await top5(server, q.question, mode));
    }
  });

  it.each(["hybrid", "vector", "fulltext"] as const)("reproduces the gold ranks of the eval report (%s)", async (mode) => {
    const expected = report.retrieval.find((r) => r.mode === mode)!.ranks;
    const answerable = questions.filter((q) => q.gold?.length);
    const ranks: Record<string, number | null> = {};
    for (const q of answerable) {
      const hits = await demo.search(q.question, { mode, limit: 10 });
      const index = hits.findIndex((h) =>
        q.gold!.some((g) => h.documentName === CORPUS_PREFIX + g.document && h.content.includes(g.evidence)),
      );
      ranks[q.id] = index === -1 ? null : index + 1;
    }
    expect(ranks).toEqual(expected);
  });

  it("gives the same answers and refusals", async () => {
    for (const q of questions) {
      const [a, b] = await Promise.all([demo.ask(q.question), server.ask(q.question)]);
      expect({ answer: a.answer, refused: a.refused, cited: a.cited }, q.id).toEqual({
        answer: b.answer,
        refused: b.refused,
        cited: b.cited,
      });
    }
  });
});
