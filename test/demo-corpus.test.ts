import { afterEach, describe, expect, it } from "vitest";
import { ExtractiveAnswerer } from "../src/answer/extractive.js";
import { chunkSections, embeddingInput } from "../src/ingest/chunker.js";
import { loadMarkdown } from "../src/ingest/loaders.js";
import { DocsLibrary } from "../src/library.js";
import { Store, type PreparedDocument } from "../src/store.js";
import {
  CORPUS_FORMAT,
  CorpusError,
  decodeCorpus,
  encodeEmbeddings,
  importCorpus,
  type CorpusManifest,
} from "../web-demo/src/corpus.js";
import { HashingEmbedder, utf8 } from "./helpers.js";

const embedder = new HashingEmbedder(16);

async function corpusOf(files: Record<string, string>, id = "v1"): Promise<{ manifest: CorpusManifest; bytes: Uint8Array }> {
  const documents: CorpusManifest["documents"] = [];
  const vectors: number[][] = [];
  for (const [name, text] of Object.entries(files)) {
    const chunks = chunkSections(loadMarkdown(text));
    vectors.push(...(await embedder.embed(chunks.map(embeddingInput))));
    documents.push({ name, format: "markdown", chunks });
  }
  const manifest: CorpusManifest = {
    format: CORPUS_FORMAT,
    id,
    title: "Test corpus",
    attribution: "Written for this test",
    model: embedder.model,
    dimensions: embedder.dimensions,
    embeddings: "test.f32",
    documents,
    eval: null,
  };
  return { manifest, bytes: encodeEmbeddings(vectors, embedder.dimensions) };
}

const FILES = {
  "docs/refunds.md": "# Refunds\nRefunds are accepted within 30 days of purchase.",
  "docs/invoices.md": "# Invoices\nInvoices are emailed as PDF files every month.\n## Taxes\nVAT is shown on each invoice.",
};

let store: Store | null = null;
afterEach(async () => {
  await store?.close();
  store = null;
});

const openStore = async (): Promise<Store> =>
  (store = await Store.open({ dimensions: embedder.dimensions, model: embedder.model }));

describe("corpus encoding", () => {
  it("round-trips chunks and Float32 embeddings", async () => {
    const { manifest, bytes } = await corpusOf(FILES);
    const docs = decodeCorpus(JSON.parse(JSON.stringify(manifest)), bytes.slice().buffer);
    expect(docs.map((d) => d.name)).toEqual(["docs/refunds.md", "docs/invoices.md"]);
    expect(docs[1]!.chunks).toEqual(manifest.documents[1]!.chunks);
    const original = (await embedder.embed([embeddingInput(manifest.documents[1]!.chunks[0]!)]))[0]!;
    expect(docs[1]!.embeddings[0]).toEqual(Array.from(new Float32Array(original)));
  });

  it("rejects an embeddings file of the wrong size", async () => {
    const { manifest, bytes } = await corpusOf(FILES);
    expect(() => decodeCorpus(manifest, bytes.subarray(4))).toThrow(CorpusError);
  });

  it("rejects an unknown manifest format", async () => {
    const { manifest, bytes } = await corpusOf(FILES);
    expect(() => decodeCorpus({ ...manifest, format: 2 }, bytes)).toThrow(/Unsupported corpus format/);
    expect(() => decodeCorpus(null, bytes)).toThrow(CorpusError);
  });

  it("refuses vectors of the wrong size", () => {
    expect(() => encodeEmbeddings([[1, 2, 3]], 4)).toThrow(CorpusError);
  });
});

describe("importCorpus", () => {
  const load = async (files: Record<string, string>, id: string): Promise<[CorpusManifest, PreparedDocument[]]> => {
    const { manifest, bytes } = await corpusOf(files, id);
    return [manifest, decodeCorpus(manifest, bytes)];
  };

  it("imports once and skips the same corpus on the next visit", async () => {
    const s = await openStore();
    const [manifest, docs] = await load(FILES, "v1");
    expect(await importCorpus(s, manifest, docs)).toBe("imported");
    expect(await importCorpus(s, manifest, docs)).toBe("already-loaded");
    const listed = await s.listDocuments();
    expect(listed.map((d) => [d.name, d.chunkCount])).toEqual([
      ["docs/refunds.md", 1],
      ["docs/invoices.md", 2],
    ]);
  });

  it("replaces an older corpus version and keeps uploaded documents", async () => {
    const s = await openStore();
    await importCorpus(s, ...(await load(FILES, "v1")));
    const library = DocsLibrary.fromStore(s, { embedder, answerer: new ExtractiveAnswerer() });
    await library.ingest("my-notes.md", utf8("# Notes\nThe office opens at nine."));

    const next = { "docs/refunds.md": "# Refunds\nRefunds are accepted within 14 days." };
    expect(await importCorpus(s, ...(await load(next, "v2")))).toBe("imported");
    expect((await s.listDocuments()).map((d) => d.name).sort()).toEqual(["docs/refunds.md", "my-notes.md"]);

    const [hit] = await library.search("refund days", { limit: 1 });
    expect(hit?.content).toContain("14 days");
  });

  it("answers from imported chunks with the normal ask() pipeline", async () => {
    const s = await openStore();
    await importCorpus(s, ...(await load(FILES, "v1")));
    const library = DocsLibrary.fromStore(s, { embedder, answerer: new ExtractiveAnswerer() });
    const result = await library.ask("Is VAT shown on the invoice?", { minSimilarity: 0.1 });
    expect(result.refused).toBe(false);
    expect(result.sources[result.cited[0]! - 1]?.documentName).toBe("docs/invoices.md");
  });

  it("will not wrap a store whose vectors have another size", async () => {
    const s = await openStore();
    expect(() => DocsLibrary.fromStore(s, { embedder: new HashingEmbedder(8), answerer: new ExtractiveAnswerer() })).toThrow(
      RangeError,
    );
  });
});
