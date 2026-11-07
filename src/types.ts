/** A contiguous piece of a source document under one heading (and, for PDFs, on one page). */
export interface Section {
  /** Heading trail from the document title down, e.g. ["Guide", "Installation"]. */
  headings: string[];
  /** 1-based page number for paged formats (PDF); null otherwise. */
  page: number | null;
  text: string;
}

export interface Chunk {
  /** Position of the chunk inside its document, starting at 0. */
  index: number;
  headings: string[];
  page: number | null;
  content: string;
}

export interface StoredDocument {
  id: number;
  name: string;
  format: DocumentFormat;
  chunkCount: number;
  createdAt: Date;
}

export type DocumentFormat = "markdown" | "html" | "pdf" | "text";

export type SearchMode = "vector" | "fulltext" | "hybrid";

export interface SearchHit {
  chunkId: number;
  documentId: number;
  documentName: string;
  chunkIndex: number;
  headings: string[];
  page: number | null;
  content: string;
  /** Final ranking score for the chosen mode (cosine similarity, ts_rank_cd or RRF score). */
  score: number;
  /** Cosine similarity between the query and the chunk (used later to decide when to refuse). */
  similarity: number;
}

/** A retrieved chunk as shown to the answer step and the reader, numbered from 1. */
export interface Source {
  n: number;
  chunkId: number;
  documentName: string;
  headings: string[];
  page: number | null;
  content: string;
  similarity: number;
}

export type AnswerEngine = "claude" | "extractive";

export interface AskResult {
  question: string;
  /** Answer text with `[n]` markers that point into `sources`. */
  answer: string;
  /** True when the documents did not support an answer. */
  refused: boolean;
  /** Source numbers the answer actually cites, in order of first use. */
  cited: number[];
  /** Every source the answer step saw, so the UI can show what was retrieved. */
  sources: Source[];
  engine: AnswerEngine;
  /** Model id for the Claude engine, null for the extractive one. */
  model: string | null;
}
