import type { AnswerEngine, Source } from "../types.js";

export interface DraftAnswer {
  /** Answer text with `[n]` markers, or the refusal sentence. */
  text: string;
}

/** Writes an answer to a question using only the numbered sources it is given. */
export interface Answerer {
  readonly engine: AnswerEngine;
  readonly model: string | null;
  answer(question: string, sources: Source[]): Promise<DraftAnswer>;
}

export class AnswerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AnswerError";
  }
}
