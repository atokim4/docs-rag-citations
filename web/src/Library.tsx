import { useRef, useState, type DragEvent } from "react";
import type { Health, StoredDocument } from "./api.js";

const ACCEPT = ".md,.markdown,.mdx,.html,.htm,.pdf,.txt";

interface Props {
  health: Health | null;
  documents: StoredDocument[];
  error: string | null;
  uploading: boolean;
  onUpload: (files: File[]) => void;
  onRemove: (id: number) => void;
}

export function Library({ health, documents, error, uploading, onUpload, onRemove }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const chunks = documents.reduce((n, d) => n + d.chunkCount, 0);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) onUpload(files);
  };

  return (
    <aside className="library" aria-label="Document library">
      <header className="brand">
        <h1>Docs RAG</h1>
        <p>Answers from your files, with citations.</p>
        {health && (
          <span className={`engine engine--${health.engine}`} title="Answer engine">
            {health.engine === "claude" ? `Claude · ${health.model}` : "Offline extractive mode"}
          </span>
        )}
      </header>

      <div
        className={`dropzone${dragging ? " dropzone--active" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p>Drop Markdown, HTML, PDF or text files here</p>
        <button type="button" className="button" disabled={uploading} onClick={() => input.current?.click()}>
          {uploading ? "Indexing…" : "Choose files"}
        </button>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          data-testid="file-input"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length > 0) onUpload(files);
          }}
        />
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <section className="documents">
        <h2>
          Documents <span className="muted">{documents.length > 0 && `${documents.length} · ${chunks} chunks`}</span>
        </h2>
        {documents.length === 0 ? (
          <p className="muted">No documents yet. Add a file to start asking questions.</p>
        ) : (
          <ul>
            {documents.map((doc) => (
              <li key={doc.id}>
                <span className="format">{doc.format}</span>
                <span className="doc-name" title={doc.name}>
                  {doc.name}
                </span>
                <span className="muted">{doc.chunkCount}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${doc.name}`}
                  onClick={() => onRemove(doc.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
