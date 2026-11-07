import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { ExtractiveAnswerer } from "../src/answer/index.js";
import { DocsLibrary } from "../src/library.js";
import { cleanFileName, createApp } from "../src/server.js";
import type { AskResult, StoredDocument } from "../src/types.js";
import { HashingEmbedder, buildPdf } from "./helpers.js";

let library: DocsLibrary;
let app: Hono;

beforeEach(async () => {
  library = await DocsLibrary.open({ embedder: new HashingEmbedder(), answerer: new ExtractiveAnswerer() });
  app = createApp(library, { maxUploadBytes: 64 * 1024 });
});

afterEach(() => library.close());

const upload = (...files: File[]): Promise<Response> => {
  const form = new FormData();
  for (const file of files) form.append("file", file);
  return Promise.resolve(app.request("/api/documents", { method: "POST", body: form }));
};

const ask = (body: unknown): Promise<Response> =>
  Promise.resolve(
    app.request("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const GUIDE = "# Guide\n\n## Port\n\nThe server listens on port 8787 by default. Change the port with the PORT variable.";

describe("documents API", () => {
  it("ingests uploads, lists and deletes them", async () => {
    const pdf = new File([buildPdf(["Page one text.", "Page two text."])], "manual.pdf", { type: "application/pdf" });
    const res = await upload(new File([GUIDE], "guide.md"), pdf);
    expect(res.status).toBe(201);
    const { documents } = (await res.json()) as { documents: StoredDocument[] };
    expect(documents.map((d) => [d.name, d.format])).toEqual([
      ["guide.md", "markdown"],
      ["manual.pdf", "pdf"],
    ]);

    const list = (await (await app.request("/api/documents")).json()) as { documents: StoredDocument[] };
    expect(list.documents).toHaveLength(2);

    expect((await app.request(`/api/documents/${documents[0]!.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.request(`/api/documents/${documents[0]!.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await app.request("/api/documents/abc", { method: "DELETE" })).status).toBe(400);
  });

  it("rejects bad uploads with clear errors", async () => {
    const unsupported = await upload(new File(["x"], "sheet.xlsx"));
    expect(unsupported.status).toBe(415);
    const { error } = (await unsupported.json()) as { error: string };
    expect(error).toContain("Unsupported file type");

    expect((await upload(new File(["   "], "empty.md"))).status).toBe(422);
    expect((await upload()).status).toBe(400);
    expect((await upload(new File(["a".repeat(70 * 1024)], "big.md"))).status).toBe(413);
  });

  it("ingests nothing when one file in the upload is unsupported", async () => {
    const res = await upload(new File([GUIDE], "guide.md"), new File(["x"], "image.png"));
    expect(res.status).toBe(415);
    expect(await library.listDocuments()).toEqual([]);
  });
});

describe("ask API", () => {
  it("answers with citations that point at the retrieved sources", async () => {
    await upload(new File([GUIDE], "guide.md"));
    const res = await ask({ question: "Which port does the server listen on by default?" });
    expect(res.status).toBe(200);
    const result = (await res.json()) as AskResult;
    expect(result.refused).toBe(false);
    expect(result.cited).toEqual([1]);
    expect(result.answer).toContain("8787");
    expect(result.sources[0]).toMatchObject({ documentName: "guide.md", headings: ["Guide", "Port"] });
  });

  it("refuses when there are no documents", async () => {
    const result = (await (await ask({ question: "Which port?" })).json()) as AskResult;
    expect(result).toMatchObject({ refused: true, sources: [] });
  });

  it("validates the request body", async () => {
    expect((await ask({})).status).toBe(400);
    expect((await ask({ question: "   " })).status).toBe(400);
    expect((await ask({ question: "x".repeat(501) })).status).toBe(400);
    expect((await ask({ question: "Which port?", mode: "magic" })).status).toBe(400);
    const notJson = await app.request("/api/ask", { method: "POST", body: "question=port" });
    expect(notJson.status).toBe(400);
  });

  it("reports the engine on the health route and 404s unknown API routes", async () => {
    expect(await (await app.request("/api/health")).json()).toEqual({
      ok: true,
      engine: "extractive",
      model: null,
      documents: 0,
    });
    expect((await app.request("/api/nope")).status).toBe(404);
  });
});

describe("cleanFileName", () => {
  it("drops client folders and control characters", () => {
    expect(cleanFileName("C:\\Users\\me\\notes.md")).toBe("notes.md");
    expect(cleanFileName("../../etc/guide\u0000.md")).toBe("guide.md");
    expect(() => cleanFileName("folder/")).toThrow("no name");
  });
});
