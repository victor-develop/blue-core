import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "web",
  publicDir: false,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../public/app",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) {
            return "app.css";
          }
          return "assets/[name][extname]";
        },
      },
    },
  },
});
