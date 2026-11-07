import react from "@vitejs/plugin-react";
import { join } from "node:path";
import { defineConfig } from "vite";

const projectRoot = join(import.meta.dirname, "..");

export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [react()],
  // PGlite loads its own .wasm/.data files; pre-bundling would break those URLs.
  optimizeDeps: { exclude: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector"] },
  worker: { format: "es" },
  server: { fs: { allow: [projectRoot] } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
