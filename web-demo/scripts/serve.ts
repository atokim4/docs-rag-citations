/**
 * Serves the built demo (web-demo/dist) with the headers from its Netlify `_headers` file, so a
 * local run and the E2E tests see the same Content-Security-Policy as the deployed site.
 *
 *   npm run preview:demo            # random free port, printed on start
 *   PORT=4173 npm run preview:demo
 */
import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".gz": "application/gzip",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

interface HeaderRule {
  pattern: RegExp;
  headers: [string, string][];
}

/** Parses Netlify's `_headers` format: a path line, then indented `Name: value` lines. */
export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const glob = line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      rules.push({ pattern: new RegExp(`^${glob}$`), headers: [] });
    } else {
      const colon = line.indexOf(":");
      const rule = rules.at(-1);
      if (rule && colon > 0) rule.headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
  }
  return rules;
}

export async function serveDemo(root: string, port = 0): Promise<{ server: Server; url: string }> {
  const dir = resolve(root);
  const rules = parseHeaders(await readFile(join(dir, "_headers"), "utf8").catch(() => ""));

  const server = createServer((req, res) => {
    void (async () => {
      const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
      let file = resolve(dir, `.${path}`);
      if (file !== dir && !file.startsWith(dir + sep)) {
        res.writeHead(403).end();
        return;
      }
      if (path.endsWith("/")) file = join(file, "index.html");
      const info = await stat(file).catch(() => null);
      if (!info?.isFile() || path.startsWith("/_headers")) {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      for (const rule of rules) {
        if (rule.pattern.test(path)) for (const [name, value] of rule.headers) res.setHeader(name, value);
      }
      res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
      res.end(await readFile(file));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  const { port: bound } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${bound}/` };
}

if (process.argv[1] === import.meta.filename) {
  const { url } = await serveDemo(join(import.meta.dirname, "..", "dist"), Number(process.env.PORT ?? 0));
  console.log(`Demo running at ${url}`);
}
