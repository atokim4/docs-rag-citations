import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Every Markdown file under `dir`, sorted, so ingest order (and chunk ids) are stable. */
export async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}
