import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      "/api": "http://realitynauts.local:8000",
      "/ws": { target: "ws://realitynauts.local:8000", ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
