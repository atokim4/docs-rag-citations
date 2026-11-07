/**
 * The prebuilt demo corpus: chunk text in a JSON manifest plus one Float32 embedding per chunk in
 * a binary file, both made at build time by `scripts/build-corpus.ts`. Loading it means the
 * browser never has to embed hundreds of chunks on the first visit; it only embeds questions.
 *
 * Shared by the Node build script, the browser worker and the tests, so it uses no DOM or Node APIs.
 */
import type { PreparedDocument, Store } from "../../src/store.js";
import type { Chunk, DocumentFormat } from "../../src/types.js";

export const CORPUS_FORMAT = 1;

export interface CorpusDocument {
  name: string;
  format: DocumentFormat;
  chunks: Chunk[];
}

/** hit@5 and MRR@10 of one search mode, copied from the last `npm run eval` report. */
export interface EvalModeResult {
  mode: "vector" | "fulltext" | "hybrid";
  hitAt5: number;
  mrrAt10: number;
}

export interface EvalSummary {
  date: string;
  answerableQuestions: number;
  modes: EvalModeResult[];
}

export interface CorpusManifest {
  format: typeof CORPUS_FORMAT;
  /** Content hash of chunks and embeddings; a changed corpus gets a new id. */
  id: string;
  title: string;
  /** Where the documents come from and under which licence. */
  attribution: string;
  model: string;
  dimensions: number;
  /** Embeddings file name, next to the manifest. */
  embeddings: string;
  documents: CorpusDocument[];
  eval: EvalSummary | null;
}

export class CorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusError";
  }
}

const chunkCount = (manifest: Pick<CorpusManifest, "documents">): number =>
  manifest.documents.reduce((n, d) => n + d.chunks.length, 0);

/** Packs embeddings (in document, then chunk order) into little-endian Float32 bytes. */
export function encodeEmbeddings(embeddings: number[][], dimensions: number): Uint8Array {
  const floats = new Float32Array(embeddings.length * dimensions);
  embeddings.forEach((vector, i) => {
    if (vector.length !== dimensions) throw new CorpusError(`Embedding ${i} has ${vector.length} dimensions`);
    floats.set(vector, i * dimensions);
  });
  const bytes = new Uint8Array(floats.byteLength);
  const view = new DataView(bytes.buffer);
  floats.forEach((value, i) => view.setFloat32(i * 4, value, true));
  return bytes;
}

/** Checks a manifest's shape and pairs every chunk with its embedding. */
export function decodeCorpus(manifest: unknown, embeddingBytes: ArrayBuffer | Uint8Array): PreparedDocument[] {
  const m = parseManifest(manifest);
  const bytes = embeddingBytes instanceof Uint8Array ? embeddingBytes : new Uint8Array(embeddingBytes);
  const expected = chunkCount(m) * m.dimensions * 4;
  if (bytes.byteLength !== expected) {
    throw new CorpusError(`Embeddings file has ${bytes.byteLength} bytes, expected ${expected}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const readVector = (): number[] => {
    const vector = new Array<number>(m.dimensions);
    for (let d = 0; d < m.dimensions; d++, offset += 4) vector[d] = view.getFloat32(offset, true);
    return vector;
  };
  return m.documents.map((doc) => ({ ...doc, embeddings: doc.chunks.map(readVector) }));
}

function parseManifest(value: unknown): CorpusManifest {
  const m = value as Partial<CorpusManifest> | null;
  if (!m || typeof m !== "object") throw new CorpusError("Corpus manifest is not an object");
  if (m.format !== CORPUS_FORMAT) throw new CorpusError(`Unsupported corpus format ${String(m.format)}`);
  if (typeof m.id !== "string" || !m.id) throw new CorpusError("Corpus manifest has no id");
  if (!Number.isInteger(m.dimensions) || (m.dimensions ?? 0) < 1) throw new CorpusError("Bad dimensions");
  if (!Array.isArray(m.documents)) throw new CorpusError("Corpus manifest has no documents");
  for (const doc of m.documents) {
    if (typeof doc?.name !== "string" || !Array.isArray(doc.chunks)) throw new CorpusError("Malformed document");
  }
  return m as CorpusManifest;
}

const CORPUS_ID_KEY = "corpus_id";
const CORPUS_DOCUMENTS_KEY = "corpus_documents";

export type ImportOutcome = "imported" | "already-loaded";

/**
 * Loads the corpus into the store unless this exact corpus is already there (IndexedDB keeps it
 * between visits). Documents from an older corpus version that are gone now are removed;
 * uploaded documents are left alone.
 */
export async function importCorpus(
  store: Store,
  manifest: CorpusManifest,
  documents: PreparedDocument[],
): Promise<ImportOutcome> {
  if ((await store.getSetting(CORPUS_ID_KEY)) === manifest.id) return "already-loaded";

  const previous = JSON.parse((await store.getSetting(CORPUS_DOCUMENTS_KEY)) ?? "[]") as string[];
  const current = new Set(documents.map((d) => d.name));
  const stale = new Set(previous.filter((name) => !current.has(name)));
  for (const doc of await store.listDocuments()) {
    if (stale.has(doc.name)) await store.deleteDocument(doc.id);
  }

  await store.replaceDocuments(documents);
  // Written last: if the tab closes mid-import, the next visit simply imports again.
  await store.setSetting(CORPUS_DOCUMENTS_KEY, JSON.stringify([...current]));
  await store.setSetting(CORPUS_ID_KEY, manifest.id);
  return "imported";
}
