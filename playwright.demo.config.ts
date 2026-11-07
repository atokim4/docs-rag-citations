import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests of the built browser demo (`npm run build:demo` first). A static server on a free
 * port serves web-demo/dist with the production headers (CSP included); see web-demo/e2e/setup.ts.
 */
export default defineConfig({
  testDir: "web-demo/e2e",
  globalSetup: "./web-demo/e2e/setup.ts",
  timeout: 180_000,
  expect: { timeout: 60_000 },
  // Each test downloads the embedding model into a fresh browser profile; keep it gentle.
  workers: 2,
  use: {
    // Set CHROME_PATH to use an installed Chrome instead of `npx playwright install chromium`.
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } }, testIgnore: /mobile/ },
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } }, testMatch: /mobile/ },
  ],
});
