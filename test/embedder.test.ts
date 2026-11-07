import { ExtractiveAnswerer } from "../src/answer/index.js";
import { afterAll, describe, expect, it } from "vitest";
import { LocalEmbedder } from "../src/embedder.js";
import { DocsLibrary } from "../src/library.js";
import { buildPdf } from "./helpers.js";

// Uses the real MiniLM model (downloaded once, then cached).
const embedder = new LocalEmbedder();

describe("LocalEmbedder", () => {
  it("returns normalised 384-d vectors that rank paraphrases above unrelated text", async () => {
    const [query, paraphrase, unrelated] = await embedder.embed([
      "How do I get my money back?",
      "Refunds are issued to the original payment method within 5 days.",
      "The office cat is called Biscuit.",
    ]);
    expect(query).toHaveLength(384);
    expect(Math.hypot(...query!)).toBeCloseTo(1, 5);
    const cos = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i]!, 0);
    expect(cos(query!, paraphrase!)).toBeGreaterThan(cos(query!, unrelated!) + 0.1);
  });

  it("returns an empty list for no input", async () => {
    expect(await embedder.embed([])).toEqual([]);
  });
});

describe("semantic retrieval over a PDF", () => {
  let library: DocsLibrary | null = null;
  afterAll(() => library?.close());

  it("finds a page by meaning even without shared keywords", async () => {
    library = await DocsLibrary.open({ embedder, answerer: new ExtractiveAnswerer() });
    await library.ingest(
      "handbook.pdf",
      buildPdf([
        "Expenses\nSubmit receipts for travel within two weeks of the trip.",
        "Leave\nEmployees get 24 days of paid vacation per year.",
        "Equipment\nLaptops are replaced every three years.",
      ]),
    );
    const [top] = await library.search("how much holiday time do staff have", { mode: "vector", limit: 1 });
    expect(top).toMatchObject({ documentName: "handbook.pdf", page: 2 });
    expect(top!.content).toContain("24 days");
  });
});
