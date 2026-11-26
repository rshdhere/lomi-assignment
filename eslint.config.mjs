import { config } from "@repo/eslint-config/base";

export default [
  {
    ignores: [
      ".agents/**",
      ".codex/**",
      ".husky/**",
      "**/.next/**",
      "**/dist/**",
      "**/coverage/**",
      "**/next-env.d.ts",
    ],
  },
  ...config,
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    languageOptions: { globals: { console: "readonly", Bun: "readonly" } },
  },
];
