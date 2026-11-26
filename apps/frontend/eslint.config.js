import { fileURLToPath } from "node:url";
import { nextJsConfig } from "@repo/eslint-config/next-js";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...nextJsConfig,
  {
    settings: {
      next: { rootDir: fileURLToPath(new URL(".", import.meta.url)) },
    },
  },
];
