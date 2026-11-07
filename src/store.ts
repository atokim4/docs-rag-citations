import { PGlite, type Transaction } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { Chunk, DocumentFormat, SearchHit, SearchMode, StoredDocument } from "./types.js";

export interface StoreOptions {
  /**
   * Where the database lives: a directory in Node, `idb://<name>` for IndexedDB in a browser,
   * or omitted for an in-memory database.
   */
  dataDir?: string;
  /**
   * Flush to IndexedDB in the background instead of after every query. Much faster in a browser;
   * a crash can lose the last write. Ignored by the Node file system.
   */
  relaxedDurability?: boolean;
  /** Embedding size; must match the embedder used to build the database. */
  dimensions: number;
  /** Embedding model name, recorded so a database is never queried with a different model. */
  model: string;
}

/** A document whose chunks were already embedded, e.g. at build time. */
export interface PreparedDocument {
  name: string;
  format: DocumentFormat;
  chunks: Chunk[];
  embeddings: number[][];
}

export interface SearchOptions {
  mode?: SearchMode;
  limit?: number;
  /** Reciprocal rank fusion constant; 60 is the value from the original RRF paper. */
  rrfK?: number;
}

interface HitRow {
  chunk_id: number;
  document_id: number;
  document_name: string;
  chunk_index: number;
  headings: string[];
  page: number | null;
  content: string;
  score: number;
  similarity: number;
}

/**
 * Documents and chunks in Postgres (PGlite, in-process) with a pgvector HNSW index for
 * semantic search and a GIN tsvector index for keyword search. The SQL is plain Postgres,
 * so it runs unchanged on Supabase or any server with pgvector.
 */
export class Store {
  private constructor(
    private readonly db: PGlite,
    readonly dimensions: number,
  ) {}

  static async open(options: StoreOptions): Promise<Store> {
    const { dimensions } = options;
    if (!Number.isInteger(dimensions) || dimensions < 1) throw new RangeError("dimensions must be a positive integer");
    const db = await PGlite.create({
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
      ...(options.relaxedDurability ? { relaxedDurability: true } : {}),
      extensions: { vector },
    });
    try {
      await migrate(db, dimensions);
      await checkModel(db, options.model, dimensions);
      // HNSW is approximate. With the default candidate list (40) for our 20 hybrid candidates,
      // an index built row by row (server uploads) and one built in bulk (the browser demo)
      // can return different neighbours for the same query. 100 brings recall close to exact
      // at this scale for well under a millisecond more per query.
      await db.exec(`SET hnsw.ef_search = ${HNSW_EF_SEARCH}`);
    } catch (error) {
      await db.close();
      throw error;
    }
    return new Store(db, dimensions);
  }

  close(): Promise<void> {
    return this.db.close();
  }

  /** Inserts a document and its chunks atomically, replacing any document with the same name. */
  async replaceDocument(
    name: string,
    format: DocumentFormat,
    chunks: Chunk[],
    embeddings: number[][],
  ): Promise<StoredDocument> {
    const [stored] = await this.replaceDocuments([{ name, format, chunks, embeddings }]);
    return stored!;
  }

  /** Inserts many documents in one transaction (all or nothing), replacing same-named ones. */
  async replaceDocuments(documents: PreparedDocument[]): Promise<StoredDocument[]> {
    for (const { chunks, embeddings } of documents) {
      if (chunks.length !== embeddings.length) throw new Error("Each chunk needs exactly one embedding");
      for (const embedding of embeddings) this.assertDimensions(embedding);
    }

    const bulk = documents.reduce((n, d) => n + d.chunks.length, 0) >= BULK_REINDEX_CHUNKS;
    return this.db.transaction(async (tx) => {
      if (bulk) await tx.exec("DROP INDEX IF EXISTS chunks_embedding_idx");
      const stored: StoredDocument[] = [];
      for (const { name, format, chunks, embeddings } of documents) {
        await tx.query("DELETE FROM documents WHERE name = $1", [name]);
        const { rows } = await tx.query<{ id: number; created_at: Date }>(
          "INSERT INTO documents (name, format) VALUES ($1, $2) RETURNING id, created_at",
          [name, format],
        );
        const doc = rows[0]!;
        await insertChunks(tx, doc.id, chunks, embeddings);
        stored.push({ id: doc.id, name, format, chunkCount: chunks.length, createdAt: doc.created_at });
      }
      if (bulk) await tx.exec(CREATE_HNSW_INDEX);
      return stored;
    });
  }

  /** A value from the key/value settings table, or null when it is not set. */
  async getSetting(key: string): Promise<string | null> {
    const { rows } = await this.db.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]);
    return rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.query(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }

  async listDocuments(): Promise<StoredDocument[]> {
    const { rows } = await this.db.query<{
      id: number;
      name: string;
      format: DocumentFormat;
      created_at: Date;
      chunk_count: number;
    }>(
      `SELECT d.id, d.name, d.format, d.created_at, count(c.id)::int AS chunk_count
         FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
        GROUP BY d.id ORDER BY d.created_at, d.id`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      format: r.format,
      chunkCount: r.chunk_count,
      createdAt: r.created_at,
    }));
  }

  /** Returns true if a document was deleted. Its chunks go with it (ON DELETE CASCADE). */
  async deleteDocument(id: number): Promise<boolean> {
    const result = await this.db.query("DELETE FROM documents WHERE id = $1", [id]);
    return (result.affectedRows ?? 0) > 0;
  }

  async search(query: string, embedding: number[], options: SearchOptions = {}): Promise<SearchHit[]> {
    const { mode = "hybrid", limit = 5, rrfK = 60 } = options;
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    this.assertDimensions(embedding);

    const params = {
      q: query,
      embedding: toVectorLiteral(embedding),
      limit,
      candidates: Math.max(limit * 4, 20),
      rrfK,
    };
    const { sql, values } = bindNamed(SEARCH_SQL[mode], params);
    const { rows } = await this.db.query<HitRow>(sql, values);
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      documentName: r.document_name,
      chunkIndex: r.chunk_index,
      headings: r.headings,
      page: r.page,
      content: r.content,
      score: r.score,
      similarity: r.similarity,
    }));
  }

  private assertDimensions(embedding: number[]): void {
    if (embedding.length !== this.dimensions) {
      throw new RangeError(`Expected a ${this.dimensions}-dimensional embedding, got ${embedding.length}`);
    }
  }
}

const HNSW_EF_SEARCH = 100;

const CREATE_HNSW_INDEX =
  "CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);";

/**
 * Above this many new chunks, the HNSW index is dropped and rebuilt after the insert: building it
 * once is about twice as fast as updating it row by row (854 chunks: ~1.6 s instead of ~3.5 s).
 */
const BULK_REINDEX_CHUNKS = 256;

async function migrate(db: PGlite, dimensions: number): Promise<void> {
  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS settings (
      key   text PRIMARY KEY,
      value text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name       text NOT NULL UNIQUE,
      format     text NOT NULL CHECK (format IN ('markdown', 'html', 'pdf', 'text')),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      document_id integer NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
      chunk_index integer NOT NULL,
      headings    text[] NOT NULL DEFAULT '{}',
      page        integer,
      content     text NOT NULL,
      embedding   vector(${dimensions}) NOT NULL,
      fts         tsvector NOT NULL,
      UNIQUE (document_id, chunk_index)
    );

    ${CREATE_HNSW_INDEX}
    CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING gin (fts);
  `);
}

async function checkModel(db: PGlite, model: string, dimensions: number): Promise<void> {
  const expected = `${model}:${dimensions}`;
  await db.query(
    "INSERT INTO settings (key, value) VALUES ('embedding_model', $1) ON CONFLICT (key) DO NOTHING",
    [expected],
  );
  const { rows } = await db.query<{ value: string }>("SELECT value FROM settings WHERE key = 'embedding_model'");
  const actual = rows[0]?.value;
  if (actual !== expected) {
    throw new Error(
      `This database was built with embedding model ${actual}, not ${expected}. Use a new data directory.`,
    );
  }
}

/** One INSERT per document: the chunks travel as a JSON array, which is far faster than a row per query. */
async function insertChunks(
  tx: Transaction,
  documentId: number,
  chunks: Chunk[],
  embeddings: number[][],
): Promise<void> {
  if (chunks.length === 0) return;
  const rows = chunks.map((chunk, i) => ({
    chunk_index: chunk.index,
    headings: chunk.headings,
    page: chunk.page,
    content: chunk.content,
    embedding: toVectorLiteral(embeddings[i]!),
  }));
  await tx.query(
    `INSERT INTO chunks (document_id, chunk_index, headings, page, content, embedding, fts)
     SELECT $1, r.chunk_index, h.headings, r.page, r.content, r.embedding::vector,
            setweight(to_tsvector('english', array_to_string(h.headings, ' ')), 'A') ||
            setweight(to_tsvector('english', r.content), 'B')
       FROM jsonb_to_recordset($2::jsonb)
            AS r(chunk_index integer, headings jsonb, page integer, content text, embedding text)
      CROSS JOIN LATERAL (SELECT ARRAY(SELECT jsonb_array_elements_text(r.headings)) AS headings) h`,
    [documentId, JSON.stringify(rows)],
  );
}

const toVectorLiteral = (embedding: number[]): string => `[${embedding.join(",")}]`;

/** Turns a question into an OR query so one missing word does not empty the result set. */
const OR_TSQUERY = "replace(plainto_tsquery('english', :q)::text, ' & ', ' | ')::tsquery";

const HIT_COLUMNS = `c.id AS chunk_id, c.document_id, d.name AS document_name, c.chunk_index, c.headings,
  c.page, c.content, (1 - (c.embedding <=> :embedding::vector))::float8 AS similarity`;

const SEARCH_SQL: Record<SearchMode, string> = {
  vector: `
    SELECT ${HIT_COLUMNS}, (1 - (c.embedding <=> :embedding::vector))::float8 AS score
      FROM chunks c JOIN documents d ON d.id = c.document_id
     ORDER BY c.embedding <=> :embedding::vector
     LIMIT :limit`,

  fulltext: `
    SELECT ${HIT_COLUMNS}, ts_rank_cd(c.fts, ${OR_TSQUERY})::float8 AS score
      FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.fts @@ ${OR_TSQUERY}
     ORDER BY score DESC, c.id
     LIMIT :limit`,

  // Reciprocal rank fusion: each list adds 1 / (k + rank), so chunks found by both rise.
  hybrid: `
    WITH semantic AS (
      SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> :embedding::vector) AS rank
        FROM chunks c
       ORDER BY c.embedding <=> :embedding::vector
       LIMIT :candidates
    ),
    keyword AS (
      SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.fts, ${OR_TSQUERY}) DESC, c.id) AS rank
        FROM chunks c
       WHERE c.fts @@ ${OR_TSQUERY}
       ORDER BY rank
       LIMIT :candidates
    ),
    fused AS (
      SELECT coalesce(s.id, k.id) AS id,
             coalesce(1.0 / (:rrfK + s.rank), 0) + coalesce(1.0 / (:rrfK + k.rank), 0) AS score
        FROM semantic s FULL OUTER JOIN keyword k ON s.id = k.id
    )
    SELECT ${HIT_COLUMNS}, f.score::float8 AS score
      FROM fused f
      JOIN chunks c ON c.id = f.id
      JOIN documents d ON d.id = c.document_id
     ORDER BY f.score DESC, similarity DESC
     LIMIT :limit`,
};

/**
 * Replaces `:name` placeholders with positional `$n` parameters, reusing one number for
 * repeats. `::type` casts are left alone.
 */
export function bindNamed(sql: string, params: Record<string, unknown>): { sql: string; values: unknown[] } {
  const order: string[] = [];
  const text = sql.replace(/(?<!:):([a-zA-Z]\w*)/g, (_, name: string) => {
    if (!Object.hasOwn(params, name)) throw new Error(`Missing SQL parameter: ${name}`);
    let position = order.indexOf(name);
    if (position === -1) position = order.push(name) - 1;
    return `$${position + 1}`;
  });
  return { sql: text, values: order.map((name) => params[name]) };
}
