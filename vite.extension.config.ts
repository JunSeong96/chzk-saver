import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

export default defineConfig({
  publicDir: "public",
  plugins: [crx({ manifest: manifest as any })],
  build: {
    outDir: "dist-extension",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: "popup.html",
        downloader: "downloader.html",
        offscreen: "offscreen.html",
      },
      output: {
        manualChunks: undefined,
      },
    },
  },
});
