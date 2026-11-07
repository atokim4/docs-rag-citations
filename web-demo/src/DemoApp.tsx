import { useEffect, useRef, useState } from "react";
import { App } from "../../web/src/App.js";
import type { BrowserEngine } from "./engine.js";
import type { InitResult, ProgressEvent, Stage } from "./protocol.js";
import { DemoStatus } from "./DemoStatus.js";

/** Questions from the eval set: four the sample docs answer, one they do not. */
const SUGGESTIONS = [
  "How do I enable CORS for my API routes?",
  "How do I change the port number when running on Node.js?",
  "How do I stream server-sent events?",
  "How do I send an email over SMTP from a handler?",
];

export type Progress = Partial<Record<Stage, ProgressEvent>>;

interface Props {
  /** Null when the browser cannot run the demo; `unsupported` says why. */
  engine: BrowserEngine | null;
  unsupported: string | null;
}

/** The existing chat UI, backed by the in-browser engine instead of the HTTP API. */
export function DemoApp({ engine, unsupported }: Props) {
  const [started, setStarted] = useState<InitResult | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress>({});
  const warmedUp = useRef(false);

  useEffect(() => {
    if (!engine) return;
    let active = true;
    const unsubscribe = engine.subscribe((event) => setProgress((p) => ({ ...p, [event.stage]: event })));
    engine.init().then(
      (result) => {
        if (active) setStarted(result);
      },
      (error: unknown) => {
        if (active) setFatal(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [engine]);

  // The ~23 MB model is fetched only once the visitor shows intent to ask, not on page load.
  const warmUp = () => {
    if (!engine || warmedUp.current) return;
    warmedUp.current = true;
    engine.warmUp().catch(() => {
      warmedUp.current = false; // the next question retries and shows the error
    });
  };

  const problem = unsupported ?? fatal;
  if (problem || !engine) {
    return (
      <div className="fatal" role="alert">
        <h1>The demo cannot run in this browser</h1>
        <p>{problem ?? "The in-browser engine is not available."}</p>
        <p className="muted">It needs a current Chrome, Edge, Firefox or Safari with WebAssembly enabled.</p>
      </div>
    );
  }

  return (
    <App
      client={engine}
      ready={started !== null}
      suggestions={SUGGESTIONS}
      onIntent={warmUp}
      aside={<DemoStatus started={started} progress={progress} />}
    />
  );
}
