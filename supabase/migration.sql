-- Schema and hybrid search for Supabase (or any Postgres 15+ with pgvector).
-- Same tables and ranking as src/store.ts, plus a SQL function you can call with
-- supabase.rpc('hybrid_search', { query_text, query_embedding, match_count }).
-- vector(384) matches Xenova/all-MiniLM-L6-v2; change it if you use another embedding model.

create extension if not exists vector;

create table if not exists documents (
  id         integer generated always as identity primary key,
  name       text not null unique,
  format     text not null check (format in ('markdown', 'html', 'pdf', 'text')),
  created_at timestamptz not null default now()
);

create table if not exists chunks (
  id          integer generated always as identity primary key,
  document_id integer not null references documents (id) on delete cascade,
  chunk_index integer not null,
  headings    text[] not null default '{}',
  page        integer,
  content     text not null,
  embedding   vector(384) not null,
  -- Filled on insert: headings weigh more (A) than body text (B). See insertChunks in src/store.ts.
  fts         tsvector not null,
  unique (document_id, chunk_index)
);

create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_fts_idx on chunks using gin (fts);

-- Reciprocal rank fusion of a pgvector cosine search and a full-text search.
create or replace function hybrid_search(
  query_text      text,
  query_embedding vector(384),
  match_count     integer default 5,
  rrf_k           integer default 60
)
returns table (
  chunk_id      integer,
  document_name text,
  headings      text[],
  page          integer,
  content       text,
  similarity    double precision,
  score         double precision
)
language sql stable
as $$
  with params as (
    -- OR the words together so one missing word does not empty the keyword list.
    select replace(plainto_tsquery('english', query_text)::text, ' & ', ' | ')::tsquery as tsq,
           greatest(match_count * 4, 20) as candidates
  ),
  semantic as (
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as rank
      from chunks c
     order by c.embedding <=> query_embedding
     limit (select candidates from params)
  ),
  keyword as (
    select c.id, row_number() over (order by ts_rank_cd(c.fts, p.tsq) desc, c.id) as rank
      from chunks c, params p
     where c.fts @@ p.tsq
     order by rank
     limit (select candidates from params)
  ),
  fused as (
    select coalesce(s.id, k.id) as id,
           coalesce(1.0 / (rrf_k + s.rank), 0) + coalesce(1.0 / (rrf_k + k.rank), 0) as score
      from semantic s
      full outer join keyword k on s.id = k.id
  )
  select c.id, d.name, c.headings, c.page, c.content,
         (1 - (c.embedding <=> query_embedding))::double precision as similarity,
         f.score::double precision as score
    from fused f
    join chunks c on c.id = f.id
    join documents d on d.id = c.document_id
   order by f.score desc, similarity desc
   limit match_count;
$$;

-- Supabase exposes public tables through its API. Turn on row level security and add
-- policies that fit your auth model before you put real documents here.
alter table documents enable row level security;
alter table chunks enable row level security;
