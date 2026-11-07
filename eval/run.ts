/**
 * Retrieval and refusal eval over the Hono docs corpus.
 *
 *   npm run eval              # writes eval/results.md and eval/results.json
 *
 * For each answerable question the gold chunk is any chunk of the expected document that
 * contains the evidence phrase. Reports hit@1, hit@5 and MRR@10 per search mode, then runs the
 * full ask() pipeline (hybrid search + the offline extractive answerer, or Claude when an API
 * key is set) to measure refusals and whether answers cite a gold chunk.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { answererFromEnv } from "../src/answer/index.js";
import { markdownFiles } from "./corpus.js";
import { LocalEmbedder } from "../src/embedder.js";
import { loadDocument } from "../src/ingest/loaders.js";
import { DEFAULT_MIN_SIMILARITY, DocsLibrary } from "../src/library.js";
import type { SearchHit, SearchMode, Source } from "../src/types.js";

interface Gold {
  document: string;
  /** A phrase the retrieved chunk must contain. */
  evidence: string;
}

interface Question {
  id: string;
  question: string;
  /** Every passage known to answer the question; empty for questions the docs do not cover. */
  gold?: Gold[];
  expect?: "refuse";
}

interface Dataset {
  corpus: string;
  questions: Question[];
}

const MODES: SearchMode[] = ["vector", "fulltext", "hybrid"];
const DEPTH = 10;
const here = import.meta.dirname;
const root = join(here, "..");

type Retrieved = Pick<SearchHit | Source, "documentName" | "content">;

const isGold = (q: Question, hit: Retrieved): boolean =>
  (q.gold ?? []).some((g) => hit.documentName === g.document && hit.content.includes(g.evidence));

const isGoldDocument = (q: Question, hit: Retrieved): boolean =>
  (q.gold ?? []).some((g) => hit.documentName === g.document);

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { data: { type: "string" } } });
  const dataset = JSON.parse(await readFile(join(here, "questions.json"), "utf8")) as Dataset;
  const corpus = join(root, dataset.corpus);
  const answerable = dataset.questions.filter((q) => q.expect !== "refuse");
  const unanswerable = dataset.questions.filter((q) => q.expect === "refuse");
  await checkDataset(corpus, answerable);

  const library = await DocsLibrary.open({
    embedder: new LocalEmbedder(),
    answerer: answererFromEnv(),
    ...(values.data ? { dataDir: values.data } : {}),
  });
  try {
    if ((await library.listDocuments()).length === 0) {
      const started = Date.now();
      const files = await markdownFiles(corpus);
      for (const file of files) await library.ingest(relative(corpus, file), await readFile(file));
      console.error(`ingested ${files.length} files in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    }
    const docs = await library.listDocuments();
    const chunks = docs.reduce((n, d) => n + d.chunkCount, 0);

    // --- retrieval
    const retrieval = [];
    for (const mode of MODES) {
      const ranks: (number | null)[] = [];
      for (const q of answerable) {
        const hits = await library.search(q.question, { mode, limit: DEPTH });
        const index = hits.findIndex((h) => isGold(q, h));
        ranks.push(index === -1 ? null : index + 1);
      }
      retrieval.push({ mode, ...summarize(ranks), ranks });
    }

    // --- similarity gate: how well does "best cosine below T" separate the two groups?
    const bestSimilarity = async (q: Question): Promise<number> =>
      Math.max(...(await library.search(q.question, { mode: "hybrid", limit: 5 })).map((h) => h.similarity));
    const answerableSims = await Promise.all(answerable.map(bestSimilarity));
    const unanswerableSims = await Promise.all(unanswerable.map(bestSimilarity));
    const sweep = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45].map((t) => ({
      threshold: t,
      answerableKept: answerableSims.filter((s) => s >= t).length,
      unanswerableRefused: unanswerableSims.filter((s) => s < t).length,
    }));

    // --- end to end: ask() with the configured answerer
    const asks = [];
    for (const q of dataset.questions) {
      const result = await library.ask(q.question, { mode: "hybrid", limit: 5 });
      const citedGold = result.cited.some((n) => isGold(q, result.sources[n - 1]!));
      const citedDocument = result.cited.some((n) => isGoldDocument(q, result.sources[n - 1]!));
      asks.push({ id: q.id, refuse: q.expect === "refuse", refused: result.refused, citedGold, citedDocument });
    }
    const engine = library.answerer.model ? `${library.answerer.engine} (${library.answerer.model})` : library.answerer.engine;
    const answered = asks.filter((a) => !a.refuse);
    const endToEnd = {
      engine,
      correctRefusals: asks.filter((a) => a.refuse && a.refused).length,
      falseRefusals: answered.filter((a) => a.refused).length,
      citedGoldChunk: answered.filter((a) => !a.refused && a.citedGold).length,
      citedGoldDocument: answered.filter((a) => !a.refused && a.citedDocument).length,
      refusalAccuracy: asks.filter((a) => a.refuse === a.refused).length / asks.length,
    };

    const report = {
      date: new Date().toISOString().slice(0, 10),
      corpus: { documents: docs.length, chunks },
      questions: { answerable: answerable.length, unanswerable: unanswerable.length },
      retrieval: retrieval.map(({ ranks, ...rest }) => ({
        ...rest,
        ranks: Object.fromEntries(answerable.map((q, i) => [q.id, ranks[i]])),
      })),
      similarityGate: {
        default: DEFAULT_MIN_SIMILARITY,
        answerable: stats(answerableSims),
        unanswerable: stats(unanswerableSims),
        sweep,
      },
      endToEnd: { ...endToEnd, perQuestion: asks },
    };
    await writeFile(join(here, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
    const markdown = renderMarkdown(report);
    await writeFile(join(here, "results.md"), markdown);
    console.log(markdown);
  } finally {
    await library.close();
  }
}

/** Fails fast if a question points at a missing file or a phrase the file does not contain. */
async function checkDataset(corpus: string, questions: Question[]): Promise<void> {
  for (const q of questions) {
    if (!q.gold?.length) throw new Error(`${q.id}: answerable questions need at least one gold passage`);
    for (const g of q.gold) {
      const sections = await loadDocument(g.document, await readFile(join(corpus, g.document)));
      if (!sections.some((s) => s.text.includes(g.evidence))) {
        throw new Error(`${q.id}: "${g.evidence}" not found in ${g.document} after loading`);
      }
    }
  }
}

function summarize(ranks: (number | null)[]): { hitAt1: number; hitAt5: number; mrrAt10: number } {
  const n = ranks.length;
  return {
    hitAt1: ranks.filter((r) => r === 1).length / n,
    hitAt5: ranks.filter((r) => r !== null && r <= 5).length / n,
    mrrAt10: ranks.reduce<number>((sum, r) => sum + (r === null ? 0 : 1 / r), 0) / n,
  };
}

function stats(values: number[]): { min: number; median: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (x: number): number => Math.round(x * 1000) / 1000;
  return { min: round(sorted[0]!), median: round(sorted[Math.floor(sorted.length / 2)]!), max: round(sorted.at(-1)!) };
}

type Report = {
  date: string;
  corpus: { documents: number; chunks: number };
  questions: { answerable: number; unanswerable: number };
  retrieval: { mode: SearchMode; hitAt1: number; hitAt5: number; mrrAt10: number }[];
  similarityGate: {
    default: number;
    answerable: ReturnType<typeof stats>;
    unanswerable: ReturnType<typeof stats>;
    sweep: { threshold: number; answerableKept: number; unanswerableRefused: number }[];
  };
  endToEnd: {
    engine: string;
    correctRefusals: number;
    falseRefusals: number;
    citedGoldChunk: number;
    citedGoldDocument: number;
    refusalAccuracy: number;
  };
};

function renderMarkdown(r: Report): string {
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  const { answerable, unanswerable } = r.questions;
  const g = r.similarityGate;
  const e = r.endToEnd;
  return `# Eval results (${r.date})

Corpus: Hono docs, ${r.corpus.documents} Markdown files, ${r.corpus.chunks} chunks.
Questions: ${answerable} answerable, ${unanswerable} not covered by the docs.

## Retrieval (answerable questions, gold = chunk of the right file that contains the evidence phrase)

| Mode | hit@1 | hit@5 | MRR@10 |
| --- | --- | --- | --- |
${r.retrieval.map((m) => `| ${m.mode} | ${pct(m.hitAt1)} | ${pct(m.hitAt5)} | ${m.mrrAt10.toFixed(3)} |`).join("\n")}

## Similarity gate (best cosine among the top 5 hybrid hits)

Answerable: min ${g.answerable.min}, median ${g.answerable.median}, max ${g.answerable.max}.
Not covered: min ${g.unanswerable.min}, median ${g.unanswerable.median}, max ${g.unanswerable.max}.

| Threshold | answerable kept | not-covered refused |
| --- | --- | --- |
${g.sweep.map((s) => `| ${s.threshold}${s.threshold === g.default ? " (default)" : ""} | ${s.answerableKept}/${answerable} | ${s.unanswerableRefused}/${unanswerable} |`).join("\n")}

## End to end: ask() with hybrid search, top 5, ${e.engine} answerer

| Metric | Result |
| --- | --- |
| Not-covered questions refused | ${e.correctRefusals}/${unanswerable} |
| Answerable questions wrongly refused | ${e.falseRefusals}/${answerable} |
| Answers citing the gold chunk | ${e.citedGoldChunk}/${answerable} |
| Answers citing the right document | ${e.citedGoldDocument}/${answerable} |
| Refusal accuracy (all questions) | ${pct(e.refusalAccuracy)} |
`;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
