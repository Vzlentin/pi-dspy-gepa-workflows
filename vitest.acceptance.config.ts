import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/acceptance/**/*.acceptance.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    coverage: { enabled: false },
  },
});
