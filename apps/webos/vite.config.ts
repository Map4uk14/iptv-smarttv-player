import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig(({ mode }) => ({
  plugins: [solid()],

  resolve: {
    alias:
      mode === "production"
        ? {
            // hls.js is a development-only convenience so the app can be tested
            // in a desktop browser. Guarding its import with `import.meta.env.DEV`
            // is NOT enough — Rollup still resolves the dynamic import and emits
            // the full library as a chunk. Aliasing it to an inert stub is what
            // actually keeps it off the TV, where it would force software demux.
            // scripts/check-bundle.mjs fails the build if real hls.js reappears.
            "hls.js": fileURLToPath(new URL("./src/platform/hlsStub.ts", import.meta.url)),
          }
        : {},
  },
  // Packaged webOS apps load from file://, so every asset reference must be
  // relative. An absolute "/assets/..." path resolves to the filesystem root on
  // the TV and silently 404s — the app boots to a blank screen with no error.
  base: "./",
  build: {
    target: "es2017", // webOS 4.x is Chromium 53; see ARCHITECTURE.md
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // Flat, hash-free names keep the .ipk diff small between installs and
        // make on-device debugging legible.
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
  server: { port: 5173, host: true },
}));
