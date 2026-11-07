import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AskResult, SearchMode } from "./api.js";
import { RichText } from "./RichText.js";

export type Turn = { id: number; question: string; mode: SearchMode } & (
  | { state: "pending" }
  | { state: "done"; result: AskResult }
  | { state: "error"; error: string }
);

interface Props {
  turns: Turn[];
  mode: SearchMode;
  canAsk: boolean;
  selected: { turn: number; n: number } | null;
  onModeChange: (mode: SearchMode) => void;
  onAsk: (question: string) => void;
  onSelect: (turn: number, n: number) => void;
}

const MODE_LABELS: Record<SearchMode, string> = {
  hybrid: "Hybrid (vector + keyword)",
  vector: "Vector only",
  fulltext: "Keyword only",
};

export function Thread({ turns, mode, canAsk, selected, onModeChange, onAsk, onSelect }: Props) {
  const [question, setQuestion] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const busy = turns.some((t) => t.state === "pending");

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || busy || !canAsk) return;
    onAsk(text);
    setQuestion("");
  };

  return (
    <main className="thread">
      <div className="turns" aria-live="polite">
        {turns.length === 0 && (
          <div className="empty">
            <h2>Ask your documents</h2>
            <p>
              Answers quote or summarise the passages they come from. Every claim carries a numbered citation; click it to
              read the source. If the documents do not cover the question, you get “I don’t know” instead of a guess.
            </p>
          </div>
        )}
        {turns.map((turn) => (
          <article key={turn.id} className="turn">
            <p className="question">{turn.question}</p>
            <TurnAnswer turn={turn} selected={selected} onSelect={onSelect} />
          </article>
        ))}
        <div ref={end} />
      </div>

      <form className="composer" onSubmit={submit}>
        <label className="visually-hidden" htmlFor="question">
          Question
        </label>
        <input
          id="question"
          value={question}
          maxLength={500}
          autoComplete="off"
          placeholder={canAsk ? "Ask a question about your documents…" : "Add a document first"}
          disabled={!canAsk}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <label className="visually-hidden" htmlFor="mode">
          Retrieval mode
        </label>
        <select id="mode" value={mode} onChange={(e) => onModeChange(e.target.value as SearchMode)}>
          {(Object.keys(MODE_LABELS) as SearchMode[]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>
        <button type="submit" className="button button--primary" disabled={!canAsk || busy || !question.trim()}>
          Ask
        </button>
      </form>
    </main>
  );
}

function TurnAnswer({ turn, selected, onSelect }: Pick<Props, "selected" | "onSelect"> & { turn: Turn }) {
  if (turn.state === "pending") return <p className="answer answer--pending">Searching the documents…</p>;
  if (turn.state === "error") {
    return (
      <p className="answer answer--error" role="alert">
        {turn.error}
      </p>
    );
  }

  const { result } = turn;
  const active = selected?.turn === turn.id ? selected.n : null;
  const engine = result.model ? `Claude (${result.model})` : "extractive";
  if (result.refused) {
    return (
      <div className="answer answer--refused">
        <p>{result.answer}</p>
        <p className="meta">
          {result.sources.length === 0
            ? "No documents matched."
            : `None of the ${result.sources.length} closest passages answer this.`}
        </p>
      </div>
    );
  }

  return (
    <div className="answer">
      <div className="answer-body">
        <RichText text={result.answer} activeCite={active} onCite={(n) => onSelect(turn.id, n)} />
      </div>
      <ol className="citations" aria-label="Cited sources">
        {result.cited.map((n) => {
          const source = result.sources[n - 1]!;
          return (
            <li key={n}>
              <button
                type="button"
                className={`citation${active === n ? " citation--active" : ""}`}
                onClick={() => onSelect(turn.id, n)}
              >
                <span className="cite" aria-hidden="true">
                  {n}
                </span>
                <span className="citation-doc">{source.documentName}</span>
                {source.headings.length > 0 && <span className="muted"> · {source.headings.at(-1)}</span>}
                {source.page && <span className="muted"> · p. {source.page}</span>}
              </button>
            </li>
          );
        })}
      </ol>
      <p className="meta">
        {MODE_LABELS[turn.mode]} search · {result.sources.length} passages retrieved · answered by {engine}
      </p>
    </div>
  );
}
