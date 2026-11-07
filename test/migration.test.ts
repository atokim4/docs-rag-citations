import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Runs the Supabase migration from the README in PGlite to prove the SQL works. */
describe("supabase/migration.sql", () => {
  it("creates the schema and ranks with hybrid_search", async () => {
    const db = await PGlite.create({ extensions: { vector } });
    try {
      await db.exec(await readFile(join(import.meta.dirname, "..", "supabase", "migration.sql"), "utf8"));
      const unit = (i: number): string => `[${Array.from({ length: 384 }, (_, j) => (j === i ? 1 : 0)).join(",")}]`;
      await db.exec(`INSERT INTO documents (name, format) VALUES ('guide.md', 'markdown')`);
      const rows: [string[], string, number][] = [
        [["Guide", "Port"], "The server listens on port 8787.", 0],
        [["Guide", "Backups"], "Backups run every night.", 1],
      ];
      for (const [i, [headings, content, axis]] of rows.entries()) {
        await db.query(
          `INSERT INTO chunks (document_id, chunk_index, headings, content, embedding, fts)
           VALUES (1, $1, $2, $3, $4::vector,
                   setweight(to_tsvector('english', array_to_string($2::text[], ' ')), 'A') ||
                   setweight(to_tsvector('english', $3), 'B'))`,
          [i, headings, content, unit(axis)],
        );
      }

      const { rows: hits } = await db.query<{ content: string; similarity: number }>(
        "SELECT content, similarity FROM hybrid_search($1, $2::vector, 2)",
        ["which port does the server use", unit(0)],
      );
      expect(hits.map((h) => h.content)).toEqual(["The server listens on port 8787.", "Backups run every night."]);
      expect(hits[0]!.similarity).toBeCloseTo(1);
    } finally {
      await db.close();
    }
  });
});
