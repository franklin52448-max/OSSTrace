/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true"/"1" turns on the Tracer's AI agent chat panel (see src/tracer/agent/flag.ts). Unset = off. */
  readonly VITE_ENABLE_TRACER_AGENT?: string;
}
