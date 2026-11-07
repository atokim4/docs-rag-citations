/** Messages between the page and the worker that runs the whole RAG pipeline. */
import type { AskResult, SearchMode, StoredDocument } from "../../src/types.js";
import type { EvalSummary } from "./corpus.js";

export interface UploadFile {
  name: string;
  bytes: ArrayBuffer;
}

export type Request =
  | { type: "init" }
  | { type: "warm-up" }
  | { type: "documents" }
  | { type: "upload"; files: UploadFile[] }
  | { type: "remove"; documentId: number }
  | { type: "ask"; question: string; mode: SearchMode };

/** What each request resolves to. */
export interface Responses {
  init: InitResult;
  "warm-up": undefined;
  documents: StoredDocument[];
  upload: StoredDocument[];
  remove: boolean;
  ask: AskResult;
}

export interface InitResult {
  corpus: { title: string; attribution: string; chunks: number; eval: EvalSummary | null };
  /** False when IndexedDB was unavailable and the database lives in memory for this tab only. */
  persistent: boolean;
  /** Whether the prebuilt corpus was imported now or found in IndexedDB from an earlier visit. */
  corpusLoad: "imported" | "already-loaded";
  /** Milliseconds to open the database, to load the corpus into it, and for the whole start. */
  timings: { database: number; corpus: number; total: number };
}

export type Stage = "database" | "corpus" | "model" | "indexing";

/** A step the worker is busy with; `progress` is 0..1 when known. */
export interface ProgressEvent {
  type: "progress";
  stage: Stage;
  label: string;
  progress: number | null;
  done: boolean;
}

export type Envelope = { id: number } & Request;

export type Reply =
  | { type: "reply"; id: number; ok: true; value: unknown }
  /** `error` is written for the visitor and shown as is. */
  | { type: "reply"; id: number; ok: false; error: string };

export type WorkerMessage = Reply | ProgressEvent;
