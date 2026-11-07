import type { Answerer } from "./answerer.js";
import { ClaudeAnswerer, DEFAULT_ANSWER_MODEL } from "./claude.js";
import { ExtractiveAnswerer } from "./extractive.js";

export { AnswerError, type Answerer, type DraftAnswer } from "./answerer.js";
export { REFUSAL, isRefusal, resolveCitations, sourceLabel } from "./citations.js";
export { ClaudeAnswerer, DEFAULT_ANSWER_MODEL } from "./claude.js";
export { ExtractiveAnswerer } from "./extractive.js";

/**
 * Claude when an API key is configured (model from ANSWER_MODEL), otherwise the offline
 * extractive answerer. `ANSWER_ENGINE=extractive` forces the offline one.
 */
export function answererFromEnv(env: NodeJS.ProcessEnv = process.env): Answerer {
  if (env.ANSWER_ENGINE === "extractive" || !env.ANTHROPIC_API_KEY) return new ExtractiveAnswerer();
  return new ClaudeAnswerer({ model: env.ANSWER_MODEL || DEFAULT_ANSWER_MODEL });
}
