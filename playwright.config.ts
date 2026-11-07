import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 8790;
/** Fresh database per run; e2e/teardown.ts deletes it. */
export const E2E_DATA_DIR = join(tmpdir(), `docs-rag-e2e-${process.pid}`);

export default defineConfig({
  testDir: "e2e",
  globalTeardown: "./e2e/teardown.ts",
  timeout: 120_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Set CHROME_PATH to use an installed Chrome instead of `npx playwright install chromium`.
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node dist/serve.js",
    url: `http://127.0.0.1:${port}/api/health`,
    timeout: 120_000,
    env: {
      PORT: String(port),
      ANSWER_ENGINE: "extractive",
      RAG_DATA_DIR: E2E_DATA_DIR,
    },
  },
});
