import { join } from "node:path";
import { buildPdf } from "../../test/helpers.js";
import { ask, expect, test } from "./fixtures.js";

const guide = join(import.meta.dirname, "..", "..", "e2e", "fixtures", "sample-guide.md");

test("answers from the precomputed corpus with a citation that opens the source", async ({ page }) => {
  await expect(page.getByText("Runs entirely in your browser.")).toBeVisible();
  await expect(page.getByTestId("timings")).toContainText("854 precomputed chunks");
  await expect(page.getByRole("figure")).toContainText("Hybrid (RRF)");

  await page.getByRole("button", { name: "How do I enable CORS for my API routes?" }).click();
  const answer = page.locator(".answer").first();
  await expect(answer).toContainText("app.use('/api/*', cors())");

  await answer.getByRole("button", { name: "Show source 1" }).click();
  const source = page.getByTestId("source-panel");
  await expect(source.getByRole("heading", { name: "hono-docs/middleware/builtin/cors.md" })).toBeVisible();
  await expect(source).toContainText("CORS Middleware");
});

test("says it does not know when the docs do not cover the question", async ({ page }) => {
  await page.getByRole("button", { name: "How do I send an email over SMTP from a handler?" }).click();
  await expect(page.locator(".answer--refused")).toContainText("I don't know based on the provided documents.");

  const answer = await ask(page, "What is the boiling point of water at sea level?");
  await expect(answer).toHaveClass(/answer--refused/);
});

test("indexes a dropped Markdown file in the browser and keeps it after a reload", async ({ page }) => {
  await page.getByTestId("file-input").setInputFiles(guide);
  const library = page.getByRole("complementary", { name: "Document library" });
  await expect(library.getByText("sample-guide.md", { exact: true })).toBeVisible();

  const answer = await ask(page, "Which port does the server listen on by default?");
  await expect(answer).toContainText("8787");
  await expect(answer.locator(".citation-doc").first()).toHaveText("sample-guide.md");

  await page.reload();
  await expect(page.getByTestId("timings")).toContainText("corpus found in IndexedDB");
  await expect(library.getByText("sample-guide.md", { exact: true })).toBeVisible();
});

test("reads a PDF in the browser and cites its page", async ({ page }) => {
  const pdf = buildPdf([
    "Field notes (demo data)\nThe greenhouse is watered twice a day.",
    "Harvest\nTomatoes are harvested every Friday morning by the volunteers.",
  ]);
  await page.getByTestId("file-input").setInputFiles({ name: "field-notes.pdf", mimeType: "application/pdf", buffer: Buffer.from(pdf) });
  await expect(page.getByText("field-notes.pdf", { exact: true })).toBeVisible();

  const answer = await ask(page, "When are the tomatoes harvested?");
  await expect(answer).toContainText("every Friday morning");
  await expect(answer.locator(".citations")).toContainText("p. 2");
});

test("rejects an unsupported file with a clear message", async ({ page }) => {
  await page.getByTestId("file-input").setInputFiles({ name: "sheet.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("x") });
  await expect(page.getByRole("alert")).toContainText("Unsupported file type");
});
