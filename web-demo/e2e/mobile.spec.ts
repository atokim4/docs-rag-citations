import { expect, test } from "./fixtures.js";

test("fits a 390 px phone screen and answers with a citation", async ({ page }) => {
  const overflow = () => page.evaluate<number>("document.documentElement.scrollWidth - window.innerWidth");
  expect(await overflow()).toBeLessThanOrEqual(0);

  await page.getByRole("button", { name: "How do I stream server-sent events?" }).click();
  const answer = page.locator(".answer").first();
  await expect(answer.locator(".citations")).toContainText("hono-docs/");
  expect(await overflow()).toBeLessThanOrEqual(0);

  await answer.locator(".citation").first().click();
  await expect(page.getByTestId("source-panel")).toBeVisible();
});
