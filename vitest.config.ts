import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
    // The pglite-backed store tests spin up a real Postgres in wasm and take
    // seconds each. Under the default 5s they fail the whole suite when run in
    // parallel with everything else, while passing in isolation — a flake that
    // reads as a broken build.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
