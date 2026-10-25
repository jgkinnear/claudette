import { defineConfig } from "vite";

const target = process.env.CLAUDETTE_URL ?? "http://localhost:3333";

export default defineConfig({
  base: "/",
  server: {
    port: 5173,
    host: "localhost",
    proxy: {
      // The service checks the Host header (DNS-rebinding guard), so rewrite it.
      "/admin": { target, changeOrigin: true },
      "/sim": { target, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
});
