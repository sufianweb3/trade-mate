import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  // The workspace core package ships TypeScript source: bundle it (and its decimal.js dependency).
  noExternal: ["@oisniper/core", "decimal.js"],
  platform: "node",
  // node:sqlite is newer than esbuild's builtin list; keep the import (and its node: prefix) verbatim.
  external: ["playwright", "ccxt", "@napi-rs/keyring", "node:sqlite"],
});
