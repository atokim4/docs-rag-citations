import type { Progress } from "./DemoApp.js";
import type { EvalSummary } from "./corpus.js";
import type { InitResult, ProgressEvent } from "./protocol.js";

interface Props {
  started: InitResult | null;
  progress: Progress;
}

export function DemoStatus({ started, progress }: Props) {
  const model = progress.model;
  return (
    <section className="demo-status" aria-label="About this demo">
      <p className="local-note">
        <strong>Runs entirely in your browser.</strong> Postgres with pgvector (PGlite) keeps the chunks in IndexedDB,
        MiniLM embeds your question in WebAssembly, and the answer is quoted from the passages it finds. No server and
        no API key: files you add never leave this tab.
      </p>

      {!started && <Step event={progress.corpus ?? progress.database} fallback="Starting the in-browser engine" />}
      {started && !started.persistent && (
        <p className="alert" role="status">
          This browser blocked IndexedDB (private window?), so files you add are kept only until you close the tab.
        </p>
      )}
      {started && (
        <>
          {model && !model.done ? (
            <Step event={model} fallback="Loading the embedding model" />
          ) : (
            <p className="muted small">
              {model?.done
                ? model.progress === 1
                  ? "Embedding model loaded (all-MiniLM-L6-v2, quantised)."
                  : "The embedding model did not load. Asking again retries."
                : "The embedding model (about 23 MB, cached after the first visit) loads when you start typing."}
            </p>
          )}
          {progress.indexing && !progress.indexing.done && <Step event={progress.indexing} fallback="Indexing" />}
          <p className="muted small">
            Sample data: {started.corpus.attribution}
          </p>
          <p className="muted small" data-testid="timings">
            Started in {seconds(started.timings.total)}: Postgres {seconds(started.timings.database)},{" "}
            {started.corpusLoad === "already-loaded"
              ? `corpus found in IndexedDB (${seconds(started.timings.corpus)})`
              : `${started.corpus.chunks} precomputed chunks loaded in ${seconds(started.timings.corpus)}`}
            .
          </p>
          {started.corpus.eval && <EvalCard summary={started.corpus.eval} />}
        </>
      )}
    </section>
  );
}

function Step({ event, fallback }: { event: ProgressEvent | undefined; fallback: string }) {
  const value = event?.progress ?? null;
  return (
    <div className="step" role="status">
      <span>{event?.label ?? fallback}…</span>
      <progress max={1} {...(value === null ? {} : { value })} aria-label={event?.label ?? fallback} />
    </div>
  );
}

const MODE_NAMES = { hybrid: "Hybrid (RRF)", vector: "Vector only", fulltext: "Keyword only" } as const;
const percent = (x: number): string => `${Math.round(x * 100)}%`;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** The retrieval eval of the sample corpus, so visitors see how often the right passage is found. */
function EvalCard({ summary }: { summary: EvalSummary }) {
  const order = ["hybrid", "vector", "fulltext"] as const;
  const rows = order.flatMap((mode) => summary.modes.filter((m) => m.mode === mode));
  return (
    <figure className="eval-card">
      <figcaption>
        Retrieval eval: right passage in the top 5 (hit@5), {summary.answerableQuestions} hand-written questions
      </figcaption>
      <table>
        <tbody>
          {rows.map((row) => (
            <tr key={row.mode} className={row.mode === "hybrid" ? "best" : undefined}>
              <th scope="row">{MODE_NAMES[row.mode]}</th>
              <td className="bar-cell">
                <span className="bar" style={{ width: percent(row.hitAt5) }} />
              </td>
              <td className="num">{percent(row.hitAt5)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Same retrieval code as the server version; a test checks both return the same top 5 for every question. Small
        set, written by the author, run {summary.date}.
      </p>
    </figure>
  );
}
