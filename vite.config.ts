import react from "@vitejs/plugin-react";
// From vitest/config (not vite) so the `test` block below type-checks.
import { defineConfig } from "vitest/config";

// The board is a plain single-page app: `vite build` writes ./dist, which the Worker serves as
// static assets (wrangler.jsonc). The Worker itself (src/worker/index.ts) is bundled by wrangler,
// not by Vite.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The three snapshot JSONs ride in the client bundle; keep the warning for anything bigger.
    chunkSizeWarningLimit: 1200,
  },
  server: {
    // `npm run dev` serves the UI only; point /api at a running `wrangler dev` for live data.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    testTimeout: 20_000,
  },
});
