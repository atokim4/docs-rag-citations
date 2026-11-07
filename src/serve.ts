import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { answererFromEnv } from "./answer/index.js";
import { LocalEmbedder } from "./embedder.js";
import { DocsLibrary } from "./library.js";
import { createApp } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? "127.0.0.1";
const dataDir = process.env.RAG_DATA_DIR ?? "data/db";
const webRoot = join(import.meta.dirname, "..", "web", "dist");

const library = await DocsLibrary.open({ embedder: new LocalEmbedder(), answerer: answererFromEnv(), dataDir });
const app = createApp(library);

if (existsSync(webRoot)) {
  // serveStatic resolves `root` against the working directory.
  const root = relative(process.cwd(), webRoot) || ".";
  app.use("/*", serveStatic({ root }));
  app.get("/*", serveStatic({ root, path: "index.html" }));
} else {
  console.warn("web/dist not found: run `npm run build:web` to serve the UI (the API works without it)");
}

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  const engine = library.answerer.model ? `${library.answerer.engine} (${library.answerer.model})` : library.answerer.engine;
  console.log(`docs-rag-citations on http://${hostname}:${info.port}  answer engine: ${engine}`);
});

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  server.close(() => void library.close().finally(() => process.exit(0)));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
