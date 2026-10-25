import { defineConfig } from "vite";

// base "./" lets the same build run at /, under the service at /sim/, or on GitHub Pages.
export default defineConfig({
  base: "./",
  server: {
    port: 5180,
    // Live mode in dev: talk to a locally running companion service.
    // changeOrigin rewrites Host to localhost:3333, which the service's admin guard expects.
    proxy: { "/admin": { target: "http://localhost:3333", changeOrigin: true } },
  },
  build: { target: "es2022" },
});
