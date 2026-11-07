import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The first test that loads the embedding model may download it (~23 MB).
    testTimeout: 120_000,
  },
});
