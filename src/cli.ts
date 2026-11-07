import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { answererFromEnv, sourceLabel } from "./answer/index.js";
import { LocalEmbedder } from "./embedder.js";
import { detectFormat } from "./ingest/loaders.js";
import { DocsLibrary } from "./library.js";
import type { SearchMode } from "./types.js";

const USAGE = `Usage:
  rag ingest <file-or-folder>...   Load .md/.html/.pdf/.txt files into the library
  rag search "<question>"          Show the best matching chunks
  rag ask "<question>"             Answer from the documents, with citations
  rag list                         List ingested documents

Options:
  --data <dir>     Database directory (default: ./data/db, env RAG_DATA_DIR)
  --mode <mode>    vector | fulltext | hybrid (default: hybrid)
  --limit <n>      Number of results (default: 5)`;

const MODES: readonly SearchMode[] = ["vector", "fulltext", "hybrid"];

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: "string", default: process.env.RAG_DATA_DIR ?? "data/db" },
      mode: { type: "string", default: "hybrid" },
      limit: { type: "string", default: "5" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }

  const mode = values.mode as SearchMode;
  if (!MODES.includes(mode)) throw new Error(`--mode must be one of: ${MODES.join(", ")}`);
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");

  const library = await DocsLibrary.open({ embedder: new LocalEmbedder(), answerer: answererFromEnv(), dataDir: values.data });
  try {
    switch (command) {
      case "ingest":
        if (args.length === 0) throw new Error("ingest needs at least one file or folder");
        await ingestPaths(library, args);
        break;
      case "search": {
        const query = args.join(" ");
        if (!query) throw new Error('search needs a question, e.g. rag search "how do I install it?"');
        const hits = await library.search(query, { mode, limit });
        if (hits.length === 0) console.log("No matches.");
        for (const [i, hit] of hits.entries()) {
          const where = [hit.documentName, hit.headings.join(" > "), hit.page ? `p. ${hit.page}` : ""]
            .filter(Boolean)
            .join(" | ");
          console.log(`[${i + 1}] ${where}  (score ${hit.score.toFixed(4)}, cos ${hit.similarity.toFixed(3)})`);
          console.log(`    ${hit.content.replace(/\s+/g, " ").slice(0, 240)}\n`);
        }
        break;
      }
      case "ask": {
        const question = args.join(" ");
        if (!question) throw new Error('ask needs a question, e.g. rag ask "how do I install it?"');
        const result = await library.ask(question, { mode, limit });
        console.log(`${result.answer}\n`);
        for (const n of result.cited) console.log(`[${n}] ${sourceLabel(result.sources[n - 1]!)}`);
        const engine = result.model ? `${result.engine}, ${result.model}` : result.engine;
        console.error(`\n(${engine}; ${result.sources.length} sources retrieved)`);
        break;
      }
      case "list":
        for (const doc of await library.listDocuments()) {
          console.log(`${doc.id}\t${doc.format}\t${doc.chunkCount} chunks\t${doc.name}`);
        }
        break;
      default:
        throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
    }
  } finally {
    await library.close();
  }
}

/** Ingests files, walking folders recursively. Names are stored relative to the given root. */
async function ingestPaths(library: DocsLibrary, paths: string[]): Promise<void> {
  for (const root of paths) {
    const files = (await stat(root)).isDirectory() ? await listSupportedFiles(root) : [root];
    for (const file of files) {
      const name = files.length === 1 && file === root ? basename(file) : relative(root, file);
      const doc = await library.ingest(name, await readFile(file));
      console.log(`ingested ${doc.name} (${doc.chunkCount} chunks)`);
    }
  }
}

async function listSupportedFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && isSupported(e.name))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

function isSupported(name: string): boolean {
  try {
    detectFormat(name);
    return true;
  } catch {
    return false;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
