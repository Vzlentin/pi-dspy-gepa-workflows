import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    maxWorkers: 2,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**", "node_modules/**"],
    coverage: {
      provider: "istanbul",
      include: ["src/**"],
      exclude: ["src/**/index.ts", "src/launcher/cli.ts"],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
});
