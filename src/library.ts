// Import the answer modules directly (not answer/index.js) so the browser build does not pull in the Claude SDK.
import type { Answerer } from "./answer/answerer.js";
import { isRefusal, REFUSAL, resolveCitations } from "./answer/citations.js";
import { chunkSections, embeddingInput, type ChunkOptions } from "./ingest/chunker.js";
import { detectFormat, loadDocument } from "./ingest/loaders.js";
import type { Embedder } from "./embedder.js";
import { Store, type SearchOptions } from "./store.js";
import type { AskResult, SearchHit, Source, StoredDocument } from "./types.js";

export class EmptyDocumentError extends Error {
  constructor(name: string) {
    super(`No readable text found in "${name}". Scanned PDFs need OCR first.`);
    this.name = "EmptyDocumentError";
  }
}

export interface AskOptions extends SearchOptions {
  /**
   * Refuse without calling the answer step when no retrieved chunk is at least this similar
   * to the question (cosine). The default was picked from the eval; see README.
   */
  minSimilarity?: number;
}

export const DEFAULT_MIN_SIMILARITY = 0.4;

export interface LibraryOptions {
  embedder: Embedder;
  answerer: Answerer;
  dataDir?: string;
  chunking?: Partial<ChunkOptions>;
}

/** Ingest pipeline (load, chunk, embed, store) and retrieval over one document collection. */
export class DocsLibrary {
  private constructor(
    private readonly store: Store,
    private readonly embedder: Embedder,
    readonly answerer: Answerer,
    private readonly chunking: Partial<ChunkOptions>,
  ) {}

  static async open({ embedder, answerer, dataDir, chunking = {} }: LibraryOptions): Promise<DocsLibrary> {
    const store = await Store.open({
      ...(dataDir ? { dataDir } : {}),
      dimensions: embedder.dimensions,
      model: embedder.model,
    });
    return new DocsLibrary(store, embedder, answerer, chunking);
  }

  /**
   * Wraps a store the caller opened (e.g. in IndexedDB with documents loaded from a
   * precomputed corpus). The library takes ownership and closes it.
   */
  static fromStore(
    store: Store,
    { embedder, answerer, chunking = {} }: Omit<LibraryOptions, "dataDir">,
  ): DocsLibrary {
    if (store.dimensions !== embedder.dimensions) {
      throw new RangeError(`Store holds ${store.dimensions}-d vectors but the embedder makes ${embedder.dimensions}-d`);
    }
    return new DocsLibrary(store, embedder, answerer, chunking);
  }

  async ingest(name: string, data: Uint8Array): Promise<StoredDocument> {
    const format = detectFormat(name);
    const sections = await loadDocument(name, data);
    const chunks = chunkSections(sections, this.chunking);
    if (chunks.length === 0) throw new EmptyDocumentError(name);
    const embeddings = await this.embedder.embed(chunks.map(embeddingInput));
    return this.store.replaceDocument(name, format, chunks, embeddings);
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const [embedding] = await this.embedder.embed([trimmed]);
    return this.store.search(trimmed, embedding!, options);
  }

  /** Retrieves sources for a question and answers it with citations, or refuses. */
  async ask(question: string, options: AskOptions = {}): Promise<AskResult> {
    const { minSimilarity = DEFAULT_MIN_SIMILARITY, ...searchOptions } = options;
    const trimmed = question.trim();
    const hits = await this.search(trimmed, searchOptions);
    const sources: Source[] = hits.map((hit, i) => ({
      n: i + 1,
      chunkId: hit.chunkId,
      documentName: hit.documentName,
      headings: hit.headings,
      page: hit.page,
      content: hit.content,
      similarity: hit.similarity,
    }));
    const result = { question: trimmed, sources, engine: this.answerer.engine, model: this.answerer.model };

    const best = Math.max(...sources.map((s) => s.similarity));
    if (sources.length === 0 || best < minSimilarity) return { ...result, answer: REFUSAL, refused: true, cited: [] };

    const draft = await this.answerer.answer(trimmed, sources);
    const { text, cited } = resolveCitations(draft.text, sources.length);
    // An answer that cites nothing is not grounded, so it counts as a refusal too.
    if (isRefusal(text) || cited.length === 0) return { ...result, answer: REFUSAL, refused: true, cited: [] };
    return { ...result, answer: text, refused: false, cited };
  }

  listDocuments(): Promise<StoredDocument[]> {
    return this.store.listDocuments();
  }

  deleteDocument(id: number): Promise<boolean> {
    return this.store.deleteDocument(id);
  }

  close(): Promise<void> {
    return this.store.close();
  }
}
