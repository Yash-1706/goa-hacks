import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // node:sqlite + onnxruntime are happier in forked processes than in worker threads
    pool: "forks",
  },
});
