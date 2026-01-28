import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/web",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@sdk": "/src/sdk",
    },
  },
  define: {
    global: "globalThis",
  },
});
