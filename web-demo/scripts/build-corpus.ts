/**
 * Precomputes the demo corpus: loads and chunks the Hono docs with the same code the server
 * uses, embeds every chunk with the same MiniLM model, and writes
 *
 *   web-demo/public/corpus/hono-docs.json   chunk text, headings, eval summary
 *   web-demo/public/corpus/hono-docs.f32    one 384-d Float32 vector per chunk
 *
 *   npm run demo:corpus
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { markdownFiles } from "../../eval/corpus.js";
import { LocalEmbedder, type Embedder } from "../../src/embedder.js";
import { chunkSections, embeddingInput } from "../../src/ingest/chunker.js";
import { detectFormat, loadDocument } from "../../src/ingest/loaders.js";
import { CORPUS_FORMAT, encodeEmbeddings, type CorpusManifest, type EvalSummary } from "../src/corpus.js";

const root = join(import.meta.dirname, "..", "..");
export const CORPUS_DIR = join(root, "eval", "corpus", "hono-docs");
/** Corpus documents are named `hono-docs/<path>` in the demo so uploads cannot collide with them. */
export const CORPUS_PREFIX = "hono-docs/";
const OUT_DIR = join(root, "web-demo", "public", "corpus");

export interface BuiltCorpus {
  manifest: CorpusManifest;
  embeddings: Uint8Array;
}

/** Same steps as `DocsLibrary.ingest` (load, chunk, embed per document), minus the database. */
export async function buildCorpus(embedder: Embedder, evalSummary: EvalSummary | null): Promise<BuiltCorpus> {
  const documents: CorpusManifest["documents"] = [];
  const vectors: number[][] = [];
  for (const file of await markdownFiles(CORPUS_DIR)) {
    const path = relative(CORPUS_DIR, file);
    const chunks = chunkSections(await loadDocument(path, await readFile(file)));
    if (chunks.length === 0) continue;
    vectors.push(...(await embedder.embed(chunks.map(embeddingInput))));
    documents.push({ name: CORPUS_PREFIX + path, format: detectFormat(path), chunks });
  }

  const embeddings = encodeEmbeddings(vectors, embedder.dimensions);
  const id = createHash("sha256").update(JSON.stringify(documents)).update(embeddings).digest("hex").slice(0, 16);
  const manifest: CorpusManifest = {
    format: CORPUS_FORMAT,
    id,
    title: "Hono documentation",
    attribution: "Hono website docs (github.com/honojs/website @ 20aab4e), MIT licence. Used as sample data.",
    model: embedder.model,
    dimensions: embedder.dimensions,
    embeddings: "hono-docs.f32",
    documents,
    eval: evalSummary,
  };
  return { manifest, embeddings };
}

interface EvalReport {
  date: string;
  questions: { answerable: number };
  retrieval: { mode: "vector" | "fulltext" | "hybrid"; hitAt5: number; mrrAt10: number }[];
}

/** The retrieval numbers from the committed eval report, shown on the demo's eval card. */
export async function readEvalSummary(): Promise<EvalSummary> {
  const report = JSON.parse(await readFile(join(root, "eval", "results.json"), "utf8")) as EvalReport;
  return {
    date: report.date,
    answerableQuestions: report.questions.answerable,
    modes: report.retrieval.map(({ mode, hitAt5, mrrAt10 }) => ({ mode, hitAt5, mrrAt10 })),
  };
}

async function main(): Promise<void> {
  const started = Date.now();
  const { manifest, embeddings } = await buildCorpus(new LocalEmbedder(), await readEvalSummary());
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "hono-docs.json"), JSON.stringify(manifest));
  await writeFile(join(OUT_DIR, manifest.embeddings), embeddings);
  const chunks = manifest.documents.reduce((n, d) => n + d.chunks.length, 0);
  console.log(
    `corpus ${manifest.id}: ${manifest.documents.length} documents, ${chunks} chunks, ` +
      `${(embeddings.byteLength / 1024).toFixed(0)} KiB of embeddings, ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );
}

if (process.argv[1] === import.meta.filename) await main();
