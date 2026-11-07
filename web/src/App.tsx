import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type DocsClient, type Health, type SearchMode, type StoredDocument } from "./api.js";
import { Library } from "./Library.js";
import { SourcePanel } from "./SourcePanel.js";
import { Thread, type Turn } from "./Thread.js";

const errorText = (error: unknown): string => (error instanceof ApiError ? error.message : "Something went wrong");

interface Props {
  /** Backend to talk to; the HTTP API by default. */
  client?: DocsClient;
  /** Extra content under the library header (the browser demo puts its status here). */
  aside?: ReactNode;
  /** Example questions offered before the first one is asked. */
  suggestions?: string[];
  /** Set to false while the backend is still starting. */
  ready?: boolean;
  /** Called when the user is about to ask (focus or typing), e.g. to start loading a model. */
  onIntent?: () => void;
}

export function App({ client = api, aside, suggestions = [], ready = true, onIntent }: Props) {
  const [health, setHealth] = useState<Health | null>(null);
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [selected, setSelected] = useState<{ turn: number; n: number } | null>(null);

  const refresh = useCallback(async () => {
    if (!ready) return;
    try {
      const [h, docs] = await Promise.all([client.health(), client.documents()]);
      setHealth(h);
      setDocuments(docs);
    } catch (error) {
      setLibraryError(errorText(error));
    }
  }, [client, ready]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upload = async (files: File[]) => {
    setUploading(true);
    setLibraryError(null);
    try {
      await client.upload(files);
    } catch (error) {
      setLibraryError(errorText(error));
    } finally {
      setUploading(false);
      await refresh();
    }
  };

  const remove = async (id: number) => {
    setLibraryError(null);
    try {
      await client.remove(id);
    } catch (error) {
      setLibraryError(errorText(error));
    }
    await refresh();
  };

  const ask = async (question: string) => {
    const id = turns.length;
    setTurns((t) => [...t, { id, question, mode, state: "pending" }]);
    try {
      const result = await client.ask(question, mode);
      setTurns((t) => t.map((turn) => (turn.id === id ? { ...turn, state: "done", result } : turn)));
      setSelected(result.cited[0] ? { turn: id, n: result.cited[0] } : null);
    } catch (error) {
      setTurns((t) => t.map((turn) => (turn.id === id ? { ...turn, state: "error", error: errorText(error) } : turn)));
    }
  };

  const selectedTurn = selected ? turns.find((t) => t.id === selected.turn) : undefined;
  const selectedSource =
    selected && selectedTurn?.state === "done" ? selectedTurn.result.sources[selected.n - 1] : undefined;

  return (
    <div className="layout">
      <Library
        health={health}
        documents={documents}
        error={libraryError}
        uploading={uploading}
        disabled={!ready}
        aside={aside}
        onUpload={(files) => void upload(files)}
        onRemove={(id) => void remove(id)}
      />
      <Thread
        turns={turns}
        mode={mode}
        canAsk={ready && documents.length > 0}
        suggestions={suggestions}
        onIntent={onIntent}
        waitingText={ready ? undefined : "Starting the in-browser engine…"}
        selected={selected}
        onModeChange={setMode}
        onAsk={(question) => void ask(question)}
        onSelect={(turn, n) => setSelected({ turn, n })}
      />
      <SourcePanel source={selectedSource} onClose={() => setSelected(null)} />
    </div>
  );
}
