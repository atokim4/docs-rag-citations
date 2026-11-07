import { expect, test } from "@playwright/test";

test("explains clearly when the browser has no WebAssembly", async ({ page }) => {
  await page.addInitScript("delete globalThis.WebAssembly");
  await page.goto(process.env.DEMO_URL!);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("The demo cannot run in this browser");
  await expect(alert).toContainText("WebAssembly");
});
