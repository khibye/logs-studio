import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const serverPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: { outDir: "dist/web", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    port: 5173,
    proxy: { "/api": `http://localhost:${serverPort}` },
  },
});
