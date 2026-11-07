import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { AnswerError } from "./answer/index.js";
import { UnsupportedFormatError, detectFormat } from "./ingest/loaders.js";
import { EmptyDocumentError, type DocsLibrary } from "./library.js";
import type { SearchMode } from "./types.js";

export interface AppOptions {
  /** Largest accepted upload request, in bytes. */
  maxUploadBytes?: number;
  /** Longest accepted question, in characters. */
  maxQuestionLength?: number;
}

const MODES: readonly SearchMode[] = ["vector", "fulltext", "hybrid"];

/** JSON API over one document library. Static UI files are mounted by the caller. */
export function createApp(library: DocsLibrary, options: AppOptions = {}): Hono {
  const { maxUploadBytes = 20 * 1024 * 1024, maxQuestionLength = 500 } = options;
  const app = new Hono();

  app.get("/api/health", async (c) =>
    c.json({
      ok: true,
      engine: library.answerer.engine,
      model: library.answerer.model,
      documents: (await library.listDocuments()).length,
    }),
  );

  app.get("/api/documents", async (c) => c.json({ documents: await library.listDocuments() }));

  app.post(
    "/api/documents",
    bodyLimit({
      maxSize: maxUploadBytes,
      onError: () => {
        throw new HTTPException(413, { message: `Uploads are limited to ${Math.round(maxUploadBytes / 1048576)} MB` });
      },
    }),
    async (c) => {
      const form = await c.req.formData().catch(() => {
        throw new HTTPException(400, { message: "Send the files as multipart/form-data in a field named file" });
      });
      const files = form.getAll("file").filter((f) => typeof f !== "string");
      if (files.length === 0) throw new HTTPException(400, { message: "No file in the upload (field name: file)" });

      // Check every name first so a bad file does not leave half the upload ingested.
      const named = files.map((file) => ({ file, name: cleanFileName(file.name) }));
      for (const { name } of named) detectFormat(name);

      const documents = [];
      for (const { file, name } of named) {
        documents.push(await library.ingest(name, new Uint8Array(await file.arrayBuffer())));
      }
      return c.json({ documents }, 201);
    },
  );

  app.delete("/api/documents/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) throw new HTTPException(400, { message: "Document id must be a positive integer" });
    if (!(await library.deleteDocument(id))) throw new HTTPException(404, { message: "No document with that id" });
    return c.body(null, 204);
  });

  app.post("/api/ask", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const { question, mode = "hybrid" } = (body ?? {}) as { question?: unknown; mode?: unknown };
    if (typeof question !== "string" || !question.trim()) {
      throw new HTTPException(400, { message: "Send JSON with a non-empty question" });
    }
    if (question.length > maxQuestionLength) {
      throw new HTTPException(400, { message: `Questions are limited to ${maxQuestionLength} characters` });
    }
    if (typeof mode !== "string" || !MODES.includes(mode as SearchMode)) {
      throw new HTTPException(400, { message: `mode must be one of: ${MODES.join(", ")}` });
    }
    return c.json(await library.ask(question, { mode: mode as SearchMode, limit: 5 }));
  });

  app.notFound((c) =>
    c.req.path.startsWith("/api/") ? c.json({ error: "Not found" }, 404) : c.text("Not found", 404),
  );

  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof UnsupportedFormatError) return c.json({ error: error.message }, 415);
    if (error instanceof EmptyDocumentError) return c.json({ error: error.message }, 422);
    if (error instanceof AnswerError) {
      console.error(error.cause ?? error);
      return c.json({ error: error.message }, 502);
    }
    console.error(error);
    return c.json({ error: "Something went wrong on the server" }, 500);
  });

  return app;
}

/** Keeps the base name only (no folders from the client) and a sane length. */
export function cleanFileName(name: string): string {
  const base = [...(name.split(/[\\/]/).pop() ?? "")]
    .filter((ch) => ch.charCodeAt(0) >= 0x20)
    .join("")
    .trim();
  if (!base) throw new HTTPException(400, { message: "The uploaded file has no name" });
  return base.length > 200 ? base.slice(-200) : base;
}
