import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

/**
 * Strip `type="module"` and `crossorigin` from the generated index.html.
 *
 * A packaged webOS app is loaded from file://, and a module script is always
 * fetched with CORS semantics, which a file:// origin can never satisfy:
 *
 *   Access to script at 'file:///.../assets/index.js' from origin 'null'
 *   has been blocked by CORS policy
 *
 * Nothing executes and the TV shows a black screen with no error on-screen.
 * The `crossorigin` attribute puts the stylesheet in the same hole. Emitting a
 * classic script (see `format: "iife"` below) is what makes the app run off
 * the filesystem.
 *
 * `defer` is not optional here. A module script is deferred implicitly, but a
 * classic one in <head> executes before <body> is parsed, so `#root` does not
 * exist yet and `main.tsx` renders into nothing — the same black screen, one
 * layer further in.
 */
function webosClassicScripts(): Plugin {
  return {
    name: "webos-classic-scripts",
    // Build only. The dev server genuinely serves ES modules over http, where
    // they work fine; stripping type="module" there breaks it outright.
    apply: "build",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler: (html) =>
        html
          .replace(/\s+type="module"/g, "")
          .replace(/\s+crossorigin(?==|\s|>)/g, "")
          .replace(/<script(?![^>]*\sdefer)([^>]*\ssrc=)/g, "<script defer$1"),
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [solid(), webosClassicScripts()],

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
  // The EPG worker has to be a classic worker for the same file:// reason as
  // the main bundle: a module worker is fetched with CORS semantics.
  worker: { format: "iife" },
  build: {
    target: "es2017", // webOS 4.x is Chromium 53; see ARCHITECTURE.md
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // A classic script, not an ES module — see webosClassicScripts above.
        // IIFE cannot code-split, so the one dynamic import (the dev-only
        // player fallback, already aliased to a stub here) is inlined.
        format: "iife",
        inlineDynamicImports: true,
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
