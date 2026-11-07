/**
 * The page side of the worker: same interface as the HTTP client in web/src/api.ts, so the
 * existing React UI runs unchanged on top of the in-browser engine.
 */
import { ApiError, type DocsClient, type Health } from "../../web/src/api.js";
import type { InitResult, ProgressEvent, Request, Responses, WorkerMessage } from "./protocol.js";

/** Why the demo cannot run at all in this browser, or null when it can. */
export function unsupportedReason(): string | null {
  if (typeof WebAssembly !== "object") return "This browser has WebAssembly turned off or does not support it.";
  if (typeof Worker !== "function") return "This browser does not support Web Workers.";
  return null;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class BrowserEngine implements DocsClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: ProgressEvent) => void>();
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => this.receive(event.data));
    this.worker.addEventListener("error", (event) => {
      event.preventDefault();
      this.failAll(new ApiError(`The browser engine stopped: ${event.message || "script error"}`));
    });
  }

  /** Calls `listener` with every progress event until the returned function is called. */
  subscribe(listener: (event: ProgressEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Opens the database and loads the corpus; safe to call more than once. */
  init(): Promise<InitResult> {
    return this.call({ type: "init" });
  }

  /** Starts the model download early (e.g. when the user focuses the question box). */
  warmUp(): Promise<void> {
    return this.call({ type: "warm-up" });
  }

  async health(): Promise<Health> {
    return { engine: "extractive", model: null, documents: (await this.documents()).length };
  }

  documents() {
    return this.call({ type: "documents" });
  }

  async upload(files: File[]) {
    const read = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })));
    return this.call({ type: "upload", files: read }, read.map((f) => f.bytes));
  }

  async remove(id: number): Promise<void> {
    if (!(await this.call({ type: "remove", documentId: id }))) throw new ApiError("That document is already gone");
  }

  ask(question: string, mode: Parameters<DocsClient["ask"]>[1]) {
    return this.call({ type: "ask", question, mode });
  }

  private call<T extends Request>(request: T, transfer: Transferable[] = []): Promise<Responses[T["type"]]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ id, ...request }, transfer);
    });
  }

  private receive(message: WorkerMessage): void {
    if (message.type === "progress") {
      for (const listener of this.listeners) listener(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new ApiError(message.error));
  }

  private failAll(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
