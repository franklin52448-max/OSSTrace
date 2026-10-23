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

/** Replaces `import.meta.env.<name>` with a string literal in every source module before anything
 * else sees it -- including when the variable is unset, which Vite's own env handling leaves as a
 * runtime lookup. That makes an off flag's guard a plain `"" === "true"` the bundler folds away, so
 * a lazily imported module behind it (the Tracer agent panel, see src/tracer/agent/flag.ts) is never
 * emitted as a chunk, and the flag's name never appears in the built `import.meta.env` object. */
function inlineFlagPlugin(name: string): Plugin {
  const needle = `import.meta.env.${name}`;
  let value = "";
  return {
    name: "osstrace-inline-flag",
    enforce: "pre",
    configResolved(resolved) {
      // The same env Vite itself loaded (.env files for this mode + process.env), from the real root.
      const v: unknown = resolved.env[name];
      value = typeof v === "string" ? v : "";
    },
    transform(code, id) {
      if (id.includes("/node_modules/") || !code.includes(needle)) return null;
      return { code: code.replaceAll(needle, JSON.stringify(value)), map: null };
    },
  };
}

export default defineConfig({
  plugins: [inlineFlagPlugin("VITE_ENABLE_TRACER_AGENT"), react(), tailwindcss(), preloadFontsPlugin()],
  server: { port: 5301 },
});
