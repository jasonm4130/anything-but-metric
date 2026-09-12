import { defineConfig } from "vitest/config";
import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Pool 0.22 bundles a workerd binary that currently supports dates through 2026-08-22.
const workerRuntime = { miniflare: { compatibilityDate: "2026-08-22" } };

export default defineConfig({
  plugins: [cloudflareTest(workerRuntime)],
  test: {
    include: ["test/**/*.test.ts"],
    pool: cloudflarePool(workerRuntime)
  }
});
