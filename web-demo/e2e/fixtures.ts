import { test as base, expect, type Page } from "@playwright/test";

export const QUESTION_PLACEHOLDER = "Ask a question about your documents…";

/**
 * `page` opens the demo and waits until the engine has started. Every console error, page error
 * and Content-Security-Policy violation fails the test.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const url = process.env.DEMO_URL;
    if (!url) throw new Error("DEMO_URL is not set; run with --config playwright.demo.config.ts");
    const problems: string[] = [];
    page.on("console", (m) => {
      // HTTP failures are reported with their URL by the response listener below.
      if (m.text().startsWith("Failed to load resource")) return;
      if (m.type() === "error" || m.text().includes("Content-Security-Policy")) problems.push(m.text());
    });
    page.on("pageerror", (e) => problems.push(e.message));
    page.on("response", (r) => {
      if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`);
    });
    await page.goto(url);
    await expect(page.getByTestId("timings")).toBeVisible();
    await use(page);
    expect(problems, "console errors or CSP violations").toEqual([]);
  },
});

export { expect };

/** Asks a question through the composer and returns the finished answer element. */
export async function ask(page: Page, question: string) {
  const turns = page.locator(".turn");
  const before = await turns.count();
  await page.getByPlaceholder(QUESTION_PLACEHOLDER).fill(question);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const answer = turns.nth(before).locator(".answer");
  await expect(answer).not.toHaveClass(/answer--pending/);
  return answer;
}
