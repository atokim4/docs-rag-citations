import { expect, test } from "@playwright/test";
import { join } from "node:path";

const fixture = join(import.meta.dirname, "fixtures", "sample-guide.md");

test("upload a document, ask, and open a citation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Offline extractive mode")).toBeVisible();

  await page.getByTestId("file-input").setInputFiles(fixture);
  const library = page.getByRole("complementary", { name: "Document library" });
  await expect(library.getByText("sample-guide.md")).toBeVisible();

  await page.getByLabel("Question").fill("Which port does the server listen on by default?");
  await page.getByRole("button", { name: "Ask" }).click();

  const answer = page.locator(".answer").last();
  await expect(answer).toContainText("8787");
  await answer.getByRole("button", { name: "Show source 1" }).click();

  const source = page.getByTestId("source-panel");
  await expect(source.getByRole("heading", { name: "sample-guide.md" })).toBeVisible();
  await expect(source).toContainText("Sample Guide (demo data) › Configuration");
  await expect(source).toContainText("Set the PORT environment variable");
});

test("says it does not know when the documents do not cover the question", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("file-input").setInputFiles(fixture);
  await expect(page.getByText("sample-guide.md")).toBeVisible();

  await page.getByLabel("Question").fill("How do I configure a Kafka consumer group?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.locator(".answer--refused")).toContainText("I don't know based on the provided documents.");
});

test("shows an error for an unsupported file", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("file-input").setInputFiles({ name: "sheet.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("x") });
  await expect(page.getByRole("alert")).toContainText("Unsupported file type");
});
