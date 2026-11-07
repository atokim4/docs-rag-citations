import { ExtractiveAnswerer } from "../src/answer/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocsLibrary, EmptyDocumentError } from "../src/library.js";
import { bindNamed, Store } from "../src/store.js";
import { HashingEmbedder, utf8 } from "./helpers.js";

const GUIDE = `# Billing guide
## Refunds
Refund requests are accepted within 30 days of purchase. Approved refunds return to the original card.
## Invoices
Invoices are emailed as PDF files on the first day of each month.
## Cancellation
You can cancel the subscription at any time from the account page.`;

let library: DocsLibrary | null = null;
afterEach(async () => {
  await library?.close();
  library = null;
});

async function openLibrary(): Promise<DocsLibrary> {
  library = await DocsLibrary.open({ embedder: new HashingEmbedder(), answerer: new ExtractiveAnswerer() });
  return library;
}

describe("bindNamed", () => {
  it("numbers names in order of first use and leaves casts alone", () => {
    expect(bindNamed("SELECT :a::vector, :b, :a", { a: 1, b: 2 })).toEqual({
      sql: "SELECT $1::vector, $2, $1",
      values: [1, 2],
    });
  });

  it("throws on a missing parameter", () => {
    expect(() => bindNamed("SELECT :x", {})).toThrow("Missing SQL parameter: x");
  });
});

describe("DocsLibrary with PGlite + pgvector", () => {
  it("ingests a document and finds the right section in every mode", async () => {
    const lib = await openLibrary();
    const doc = await lib.ingest("billing.md", utf8(GUIDE));
    expect(doc).toMatchObject({ name: "billing.md", format: "markdown", chunkCount: 3 });

    for (const mode of ["vector", "fulltext", "hybrid"] as const) {
      const [top] = await lib.search("how many days for a refund request", { mode, limit: 3 });
      expect(top, mode).toMatchObject({ documentName: "billing.md", headings: ["Billing guide", "Refunds"] });
      expect(top!.content).toContain("30 days");
    }
  });

  it("matches stemmed keywords and heading text in full-text mode", async () => {
    const lib = await openLibrary();
    await lib.ingest("billing.md", utf8(GUIDE));
    const hits = await lib.search("cancelling", { mode: "fulltext" });
    expect(hits[0]!.headings).toEqual(["Billing guide", "Cancellation"]);
  });

  it("ranks a chunk found by both retrievers first in hybrid mode", async () => {
    const lib = await openLibrary();
    await lib.ingest("billing.md", utf8(GUIDE));
    const hits = await lib.search("invoices emailed monthly", { mode: "hybrid", limit: 3 });
    expect(hits[0]!.headings.at(-1)).toBe("Invoices");
    // RRF scores are sorted and bounded by 2 / (k + 1).
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a));
    expect(hits[0]!.score).toBeLessThanOrEqual(2 / 61);
  });

  it("replaces a re-ingested document and deletes with its chunks", async () => {
    const lib = await openLibrary();
    await lib.ingest("billing.md", utf8(GUIDE));
    const second = await lib.ingest("billing.md", utf8("# Billing guide\nAll sales are final."));
    const docs = await lib.listDocuments();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ id: second.id, chunkCount: 1 });

    expect(await lib.deleteDocument(second.id)).toBe(true);
    expect(await lib.deleteDocument(second.id)).toBe(false);
    expect(await lib.search("sales final")).toEqual([]);
  });

  it("returns nothing for a blank query and rejects documents without text", async () => {
    const lib = await openLibrary();
    expect(await lib.search("   ")).toEqual([]);
    await expect(lib.ingest("empty.md", utf8("# Only a heading\n"))).rejects.toThrow(EmptyDocumentError);
    expect(await lib.listDocuments()).toEqual([]);
  });

  it("keeps data in a persistent directory and refuses a different embedding model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rag-store-"));
    try {
      const embedder = new HashingEmbedder();
      const first = await DocsLibrary.open({ embedder, answerer: new ExtractiveAnswerer(), dataDir: dir });
      await first.ingest("billing.md", utf8(GUIDE));
      await first.close();

      library = await DocsLibrary.open({ embedder, answerer: new ExtractiveAnswerer(), dataDir: dir });
      expect((await library.listDocuments()).map((d) => d.name)).toEqual(["billing.md"]);
      await library.close();
      library = null;

      await expect(Store.open({ dataDir: dir, dimensions: 32, model: "other" })).rejects.toThrow(/embedding model/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
