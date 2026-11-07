import { rm } from "node:fs/promises";
import { E2E_DATA_DIR } from "../playwright.config.js";

export default async function teardown(): Promise<void> {
  await rm(E2E_DATA_DIR, { recursive: true, force: true });
}
