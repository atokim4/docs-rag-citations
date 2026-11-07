/**
 * Runs the RAG pipeline off the main thread: PGlite + pgvector in IndexedDB, MiniLM embeddings in
 * WebAssembly, and the same DocsLibrary, chunker and extractive answerer the server uses.
 */
import { env } from "@huggingface/transformers";
// Same file the onnxruntime-web bundle asks for; served from this site instead of a third-party CDN.
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { ExtractiveAnswerer } from "../../src/answer/extractive.js";
import { LocalEmbedder, type ProgressInfo } from "../../src/embedder.js";
import { UnsupportedFormatError, detectFormat } from "../../src/ingest/loaders.js";
import { DocsLibrary, EmptyDocumentError } from "../../src/library.js";
import { Store, type PreparedDocument } from "../../src/store.js";
import { CorpusError, decodeCorpus, importCorpus, type CorpusManifest } from "./corpus.js";
import type { Envelope, InitResult, ProgressEvent, Reply, Request, Responses, Stage, WorkerMessage } from "./protocol.js";

/** The parts of DedicatedWorkerGlobalScope used here (the DOM and WebWorker libs cannot be mixed). */
interface WorkerScope {
  readonly location: { readonly href: string };
  postMessage(message: WorkerMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent<Envelope>) => void): void;
}
const scope = self as unknown as WorkerScope;

const DB_NAME = "idb://docs-rag-demo";
// The worker script lives in assets/, the corpus in corpus/ next to it; relative, so the demo
// also works when hosted under a sub-path.
const CORPUS_URL = new URL("../corpus/hono-docs.json", scope.location.href);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_QUESTION_LENGTH = 500;

// Models come from the Hugging Face CDN; never look for them on this site.
env.allowLocalModels = false;
env.backends.onnx.wasm!.wasmPaths = { wasm: ortWasmUrl };

/** An error whose message is written for the visitor. */
class DemoError extends Error {}

const post = (message: Reply | ProgressEvent): void => scope.postMessage(message);
const progress = (stage: Stage, label: string, value: number | null = null, done = false): void =>
  post({ type: "progress", stage, label, progress: value, done });

/** Turns transformers.js file events into one progress bar over all model files. */
function modelProgress(): (info: ProgressInfo) => void {
  return (info) => {
    if (info.status === "progress_total") {
      progress("model", "Downloading the embedding model", info.total > 0 ? info.loaded / info.total : null);
    } else if (info.status === "ready") {
      progress("model", "Embedding model ready", 1, true);
    }
  };
}

const embedder = new LocalEmbedder(undefined, { onProgress: modelProgress() });
let library: DocsLibrary | null = null;
let starting: Promise<InitResult> | null = null;

async function openStore(): Promise<{ store: Store; persistent: boolean }> {
  const options = { dimensions: embedder.dimensions, model: embedder.model };
  try {
    return { store: await Store.open({ ...options, dataDir: DB_NAME, relaxedDurability: true }), persistent: true };
  } catch (error) {
    // Private windows and some browser settings block IndexedDB; keep working in memory.
    console.warn("IndexedDB unavailable, using an in-memory database", error);
    try {
      return { store: await Store.open(options), persistent: false };
    } catch (inner) {
      throw new DemoError(`Could not start the in-browser database: ${message(inner)}`);
    }
  }
}

async function download(url: URL): Promise<Response> {
  const response = await fetch(url).catch(() => null);
  if (!response?.ok) {
    const status = response ? ` (HTTP ${response.status})` : "";
    throw new DemoError(`Could not download the sample corpus${status}. Check your connection and reload the page.`);
  }
  return response;
}

async function fetchCorpus(): Promise<{ manifest: CorpusManifest; bytes: ArrayBuffer }> {
  const manifest = (await (await download(CORPUS_URL)).json()) as CorpusManifest;
  const bytes = await (await download(new URL(manifest.embeddings, CORPUS_URL))).arrayBuffer();
  return { manifest, bytes };
}

async function init(): Promise<InitResult> {
  const started = performance.now();
  progress("database", "Starting Postgres (PGlite) in your browser");
  const downloading = fetchCorpus();
  downloading.catch(() => undefined); // handled below; avoids an unhandled rejection if the database fails first
  const { store, persistent } = await openStore();
  const databaseMillis = performance.now() - started;
  progress("database", "Database ready", 1, true);
  let corpus: Awaited<typeof downloading>;
  try {
    corpus = await downloading;
  } catch (error) {
    await store.close();
    throw error;
  }
  const importStarted = performance.now();

  progress("corpus", "Loading the sample corpus");
  let corpusLoad: InitResult["corpusLoad"];
  let documents: PreparedDocument[];
  try {
    documents = decodeCorpus(corpus.manifest, corpus.bytes);
    corpusLoad = await importCorpus(store, corpus.manifest, documents);
  } catch (error) {
    await store.close();
    if (error instanceof CorpusError) throw new DemoError(`The sample corpus is damaged: ${error.message}`);
    throw error;
  }
  progress("corpus", "Sample corpus ready", 1, true);

  library = DocsLibrary.fromStore(store, { embedder, answerer: new ExtractiveAnswerer() });
  const { title, attribution, eval: evalSummary } = corpus.manifest;
  return {
    corpus: { title, attribution, chunks: documents.reduce((n, d) => n + d.chunks.length, 0), eval: evalSummary },
    persistent,
    corpusLoad,
    timings: {
      database: Math.round(databaseMillis),
      corpus: Math.round(performance.now() - importStarted),
      total: Math.round(performance.now() - started),
    },
  };
}

function ready(): DocsLibrary {
  if (!library) throw new DemoError("The demo is still starting");
  return library;
}

/** The model is downloaded on first use; this wraps that so a failure reads as a model problem. */
async function withModel<T>(work: () => Promise<T>): Promise<T> {
  try {
    await embedder.warmUp();
  } catch (error) {
    progress("model", "The embedding model failed to load", null, true);
    throw new DemoError(`Could not load the embedding model: ${message(error)}. Check your connection and retry.`);
  }
  return work();
}

async function upload(files: { name: string; bytes: ArrayBuffer }[]): Promise<Responses["upload"]> {
  const lib = ready();
  // Check every file first so one bad file does not leave half the upload indexed.
  for (const file of files) {
    detectFormat(file.name);
    if (file.bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new DemoError(`${file.name} is larger than ${MAX_UPLOAD_BYTES / 1048576} MB`);
    }
  }
  return withModel(async () => {
    const stored = [];
    try {
      for (const [i, file] of files.entries()) {
        progress("indexing", `Indexing ${file.name}`, i / files.length);
        stored.push(await lib.ingest(file.name, new Uint8Array(file.bytes)));
      }
    } finally {
      progress("indexing", "Indexing finished", 1, true);
    }
    return stored;
  });
}

async function handle(request: Request): Promise<unknown> {
  switch (request.type) {
    case "init":
      // Idempotent, so a remounted page (React StrictMode) gets the same result.
      starting ??= init().catch((error: unknown) => {
        starting = null;
        throw error;
      });
      return starting;
    case "warm-up":
      return withModel(() => Promise.resolve(undefined));
    case "documents":
      return ready().listDocuments();
    case "upload":
      return upload(request.files);
    case "remove":
      return ready().deleteDocument(request.documentId);
    case "ask": {
      const question = request.question.trim();
      if (!question) throw new DemoError("Type a question first");
      if (question.length > MAX_QUESTION_LENGTH) {
        throw new DemoError(`Questions are limited to ${MAX_QUESTION_LENGTH} characters`);
      }
      const lib = ready();
      return withModel(() => lib.ask(question, { mode: request.mode, limit: 5 }));
    }
  }
}

function toReply(id: number, error: unknown): Reply {
  const known = error instanceof DemoError || error instanceof UnsupportedFormatError || error instanceof EmptyDocumentError;
  if (!known) console.error(error);
  const text = known ? error.message : "Something went wrong in the browser engine. Reloading the page usually helps.";
  return { type: "reply", id, ok: false, error: text };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

scope.addEventListener("message", (event: MessageEvent<Envelope>) => {
  const { id, ...request } = event.data;
  handle(request).then(
    (value) => post({ type: "reply", id, ok: true, value }),
    (error: unknown) => post(toReply(id, error)),
  );
});
