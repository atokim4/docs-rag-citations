import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../web/src/styles.css";
import { DemoApp } from "./DemoApp.js";
import { BrowserEngine, unsupportedReason } from "./engine.js";
import "./demo.css";

// One engine (and worker) for the life of the page.
const unsupported = unsupportedReason();
const engine = unsupported ? null : new BrowserEngine();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DemoApp engine={engine} unsupported={unsupported} />
  </StrictMode>,
);
