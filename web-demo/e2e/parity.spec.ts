/**
 * In-browser parity: questions are embedded by MiniLM in WebAssembly here, while the Vitest
 * parity test embeds them with onnxruntime in Node. Both must lead to the same answers.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ExtractiveAnswerer } from "../../src/answer/extractive.js";
import { LocalEmbedder } from "../../src/embedder.js";
import { DocsLibrary } from "../../src/library.js";
import { Store } from "../../src/store.js";
import { decodeCorpus, importCorpus, type CorpusManifest } from "../src/corpus.js";
import { ask, expect, test } from "./fixtures.js";

interface Outcome {
  refused: boolean;
  /** Cited documents, in citation order. */
  cited: string[];
}

const root = join(import.meta.dirname, "..", "..");

/** What the same corpus and questions give in Node (onnxruntime query embeddings). */
async function nodeOutcomes(questions: string[]): Promise<Outcome[]> {
  const dir = join(root, "web-demo", "dist", "corpus");
  const manifest = JSON.parse(await readFile(join(dir, "hono-docs.json"), "utf8")) as CorpusManifest;
  const store = await Store.open({ dimensions: manifest.dimensions, model: manifest.model });
  await importCorpus(store, manifest, decodeCorpus(manifest, await readFile(join(dir, manifest.embeddings))));
  const library = DocsLibrary.fromStore(store, { embedder: new LocalEmbedder(), answerer: new ExtractiveAnswerer() });
  try {
    const outcomes = [];
    for (const question of questions) {
      const result = await library.ask(question);
      outcomes.push({ refused: result.refused, cited: result.cited.map((n) => result.sources[n - 1]!.documentName) });
    }
    return outcomes;
  } finally {
    await library.close();
  }
}

test("the 30 eval questions get the same answers in the browser as in Node", async ({ page }) => {
  const dataset = JSON.parse(await readFile(join(root, "eval", "questions.json"), "utf8")) as {
    questions: { question: string }[];
  };
  const questions = dataset.questions.map((q) => q.question);
  const expected = await nodeOutcomes(questions);

  const actual: Outcome[] = [];
  for (const question of questions) {
    const answer = await ask(page, question);
    const refused = ((await answer.getAttribute("class")) ?? "").includes("answer--refused");
    actual.push({ refused, cited: await answer.locator(".citation-doc").allInnerTexts() });
  }
  expect(actual).toEqual(expected);
});
