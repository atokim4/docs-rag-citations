import { Fragment } from "react";
import { blocksOf } from "../../src/answer/extractive.js";
import type { Source } from "./api.js";
import { parseInline } from "./answerText.js";

interface Props {
  source: Source | undefined;
  onClose: () => void;
}

export function SourcePanel({ source, onClose }: Props) {
  if (!source) {
    return (
      <aside className="source source--empty" aria-label="Source">
        <p className="muted">Click a citation to read the passage it came from.</p>
      </aside>
    );
  }
  return (
    <aside className="source" aria-label="Source" data-testid="source-panel">
      <header>
        <span className="cite cite--active" aria-hidden="true">
          {source.n}
        </span>
        <div>
          <h2 title={source.documentName}>{source.documentName}</h2>
          {source.headings.length > 0 && <p className="trail">{source.headings.join(" › ")}</p>}
        </div>
        <button type="button" className="icon-button" aria-label="Close source" onClick={onClose}>
          ×
        </button>
      </header>
      <dl className="facts">
        {source.page && (
          <>
            <dt>Page</dt>
            <dd>{source.page}</dd>
          </>
        )}
        <dt>Similarity</dt>
        <dd>{source.similarity.toFixed(2)}</dd>
      </dl>
      <div className="snippet">
        {/* blocksOf copes with chunks that start or end inside a fenced code block. */}
        {blocksOf(source.content).map((block, i) =>
          block.code ? (
            <pre key={i}>
              <code>{block.text}</code>
            </pre>
          ) : (
            <p key={i}>
              {parseInline(block.text, false).map((part, j) => (
                <Fragment key={j}>{part.kind === "code" ? <code>{part.text}</code> : part.kind === "text" ? part.text : null}</Fragment>
              ))}
            </p>
          ),
        )}
      </div>
    </aside>
  );
}
