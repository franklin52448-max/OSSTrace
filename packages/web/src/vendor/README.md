# vendor

Third-party UI code copied into the repo, each under its own license. Local changes are marked
in the file.

## AeroShards.tsx

The WebGPU "Aero Shards" background from [React Bits](https://reactbits.dev/backgrounds/aero-shards)
by David Haz ([source](https://github.com/DavidHDev/react-bits/tree/main/src/ts-tailwind/Backgrounds/AeroShards)),
with the demo's "graphite" preset (chrome material, `#a1a1aa` / `#e4e4e7`, billow 0.7, glow 0.25).
It's the home page hero (`src/App.tsx`, `HeroBackground`). Vendored unchanged apart from the header.

It renders through `vgpu` (vercel-labs, MIT), pinned to 0.3.1 — the version upstream targets.
`vgpu` lists its Node adapter as a regular dependency, which installs the native `webgpu` package
(~70 MB, with a postinstall script); none of that reaches the browser bundle.

Where WebGPU is unavailable (or fails to start), `HeroBackground` falls back to Ferrofluid below.

License: **MIT + Commons Clause v1.0**, same terms and caveat as Ferrofluid below.

## Ferrofluid.tsx

The animated WebGL2 ferrofluid background from [React Bits](https://reactbits.dev/backgrounds/ferrofluid)
by David Haz ([source](https://github.com/DavidHDev/react-bits/tree/main/src/ts-tailwind/Backgrounds/Ferrofluid)).
It's the home hero's fallback where WebGPU isn't available (`src/App.tsx`, `HeroBackground`).

One local patch, marked `OSSTrace patch` in the file: upstream's cleanup always calls
`loseContext()`. Under React StrictMode (dev), the effect is cleaned up and re-run on the same
canvas, which left it dead and white. The patch only releases the context once the canvas has
really been removed from the page.

License: **MIT + Commons Clause v1.0.** It may be used, modified and distributed as part of an
application or website, as long as the copyright notice is kept. The component itself may not be
sold, sublicensed or redistributed on its own. That restriction is stricter than the AGPL-3.0 the
rest of OSSTrace uses, so this file is not covered by the project's AGPL grant. Remove it (the home
page works without it) before redistributing OSSTrace in a way the Commons Clause forbids.
