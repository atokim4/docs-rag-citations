import { Fragment } from "react";
import { parseAnswer, type Inline } from "./answerText.js";

interface Props {
  text: string;
  /** Renders `[n]` markers as buttons; leave out to show them as plain text. */
  onCite?: (n: number) => void;
  activeCite?: number | null;
}

/** Paragraphs, inline code, fenced code and (optionally) citation chips, without innerHTML. */
export function RichText({ text, onCite, activeCite = null }: Props) {
  const blocks = parseAnswer(text, { citations: Boolean(onCite) });
  return (
    <>
      {blocks.map((block, i) =>
        block.kind === "code" ? (
          <pre key={i}>
            <code>{block.text}</code>
          </pre>
        ) : (
          <p key={i}>
            {block.parts.map((part, j) => (
              <Fragment key={j}>{renderInline(part, onCite, activeCite)}</Fragment>
            ))}
          </p>
        ),
      )}
    </>
  );
}

function renderInline(part: Inline, onCite: Props["onCite"], activeCite: number | null) {
  switch (part.kind) {
    case "text":
      return part.text;
    case "code":
      return <code>{part.text}</code>;
    case "cite":
      return (
        <button
          type="button"
          className={`cite${activeCite === part.n ? " cite--active" : ""}`}
          aria-label={`Show source ${part.n}`}
          aria-pressed={activeCite === part.n}
          onClick={() => onCite?.(part.n)}
        >
          {part.n}
        </button>
      );
  }
}
