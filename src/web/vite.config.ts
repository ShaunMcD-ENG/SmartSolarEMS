import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite root is src/web (invoked as `vite build --root src/web`); this config
// file lives in that same directory, so all paths here are relative to it.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
