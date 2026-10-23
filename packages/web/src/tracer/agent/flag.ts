/**
 * Build-time switch for the Tracer's AI agent chat panel.
 *
 * The feature is not announced yet, so it is OFF unless a build explicitly sets
 * `VITE_ENABLE_TRACER_AGENT=true` (or `1`). Leaving the variable unset -- the default for every
 * existing build, preview and deploy -- keeps the panel, its toolbar button and its network calls
 * out of the page entirely, even if this code somehow ends up in a build by accident.
 *
 * vite.config.ts's `inlineFlagPlugin` replaces `import.meta.env.VITE_ENABLE_TRACER_AGENT` with a
 * string literal in every module (also when it's unset, which Vite alone would leave as a runtime
 * lookup), so with the flag off this folds to `false`, the minifier drops every guarded branch,
 * the lazily imported panel module (see TracerPage.tsx) is never emitted as a chunk, and the flag's
 * name doesn't appear in the bundle. In tests, tests/harness/env.ts builds `import.meta.env` from
 * `process.env`, so a test turns it on by setting the variable before importing the page.
 */
export const TRACER_AGENT_ENABLED: boolean = import.meta.env.VITE_ENABLE_TRACER_AGENT === "true" || import.meta.env.VITE_ENABLE_TRACER_AGENT === "1";
