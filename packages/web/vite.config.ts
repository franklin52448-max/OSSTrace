import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Preloads the first-paint font files (see src/fonts.css) so the browser starts fetching them
 * alongside the HTML instead of only discovering them after parsing CSS -- which is what the
 * flash of fallback-font text before the real font swaps in actually comes from. Vite content-hashes
 * these filenames per build, so the href can't be hardcoded in index.html; this reads the real
 * emitted asset names off the build's own bundle. Production build only (dev serves fonts straight
 * from node_modules with no hash to preload against, and reloads too often for it to matter). */
function preloadFontsPlugin(): Plugin {
  return {
    name: "osstrace-preload-fonts",
    apply: "build",
    transformIndexHtml: {
      // Runs after the bundle is generated, so ctx.bundle is actually populated -- the default
      // order runs too early for that.
      order: "post",
      handler(_html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return [];
        const fontFiles = Object.values(bundle)
          .filter((item) => item.type === "asset" && /\/(instrument-sans-latin|jetbrains-mono-latin)/.test(item.fileName))
          .map((item) => item.fileName);
        return fontFiles.map((fileName) => ({
          tag: "link",
          injectTo: "head",
          attrs: { rel: "preload", as: "font", type: "font/woff2", crossorigin: "", href: `/${fileName}` },
        }));
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), preloadFontsPlugin()],
  server: { port: 5301 },
});
