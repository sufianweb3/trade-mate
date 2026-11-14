import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": resolve(__dirname) } },
  test: { name: "panel", environment: "jsdom", testTimeout: 15_000, include: ["test/**/*.test.tsx"], setupFiles: ["test/setup.ts"] },
});
