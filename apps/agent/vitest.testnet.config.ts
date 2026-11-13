import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "testnet", include: ["test/testnet/**/*.test.ts"], testTimeout: 120000, fileParallelism: false },
});
