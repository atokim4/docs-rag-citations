import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/", "data/", "web/dist/", "web-demo/dist/", ".scratch/", "test-results/", "playwright-report/"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: "./tsconfig.test.json", tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      parserOptions: { project: "./web/tsconfig.json", tsconfigRootDir: import.meta.dirname },
    },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ["web-demo/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      parserOptions: { project: "./web-demo/tsconfig.json", tsconfigRootDir: import.meta.dirname },
    },
    rules: reactHooks.configs.recommended.rules,
  },
  { files: ["eslint.config.js"], ...tseslint.configs.disableTypeChecked },
);
