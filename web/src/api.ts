import type { AskResult, SearchMode, StoredDocument } from "../../src/types.js";

export type { AskResult, SearchMode, Source, StoredDocument } from "../../src/types.js";

export interface Health {
  engine: "claude" | "extractive";
  model: string | null;
  documents: number;
}

/** Error with the message the API sent back, ready to show to the user. */
export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("Cannot reach the server. Is it running?");
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

/** What the UI needs from a backend: the HTTP API here, or the in-browser engine of the demo. */
export interface DocsClient {
  health(): Promise<Health>;
  documents(): Promise<StoredDocument[]>;
  upload(files: File[]): Promise<StoredDocument[]>;
  remove(id: number): Promise<void>;
  ask(question: string, mode: SearchMode): Promise<AskResult>;
}

export const api: DocsClient = {
  health: () => request<Health>("/api/health"),
  documents: async () => (await request<{ documents: StoredDocument[] }>("/api/documents")).documents,
  upload: async (files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append("file", file);
    return (await request<{ documents: StoredDocument[] }>("/api/documents", { method: "POST", body: form })).documents;
  },
  remove: (id: number) => request<void>(`/api/documents/${id}`, { method: "DELETE" }),
  ask: (question: string, mode: SearchMode) =>
    request<AskResult>("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, mode }),
    }),
};
