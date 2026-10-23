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

Where WebGPU is unavailable (or fails to start), `HeroBackground` renders nothing and the page's
own background shows instead.

License: **MIT + Commons Clause v1.0.** It may be used, modified and distributed as part of an
application or website, as long as the copyright notice is kept. The component itself may not be
sold, sublicensed or redistributed on its own. That restriction is stricter than the AGPL-3.0 the
rest of OSSTrace uses, so this file is not covered by the project's AGPL grant. Remove it (the home
page works without it) before redistributing OSSTrace in a way the Commons Clause forbids.

## Chain marks on the home page

The unsupported-chain logos under "Add a chain" in `src/HomeFeatures.tsx` (`WANTED_CHAINS`) are SVG paths
copied in, not a dependency:

- Bitcoin and Robinhood: [Simple Icons](https://simpleicons.org) 16.35.0, **CC0-1.0** (the same
  set `src/ChainSelect.tsx` uses for Ethereum and Solana).
- Tron and Monad: [Web3 Icons](https://web3icons.io) (`@web3icons/core` 4.0.58, branded network
  icons) by 0xa3k5, **MIT**, which allows this as long as the credit is kept.

The marks are trademarks of their projects, shown only to name chains OSSTrace doesn't support yet.

## Label-data marks on the home page

The logos under "Add label data" in `src/HomeFeatures.tsx` (`WANTED_LABELS`) name kinds of label data
nobody has contributed yet:

- Binance: [Simple Icons](https://simpleicons.org) 16.35.0, **CC0-1.0**.
- US Government: the coat of arms from the obverse of the Great Seal, a US Government work in the
  **public domain** ([Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Great_Seal_of_the_United_States_(obverse).svg)),
  cropped to the eagle and rendered to a 96px PNG at `public/us-coat-of-arms.png`.
- BlackRock and pump.fun: simplified redrawings of their favicons (a white "B" on black; a
  green-and-white pill), drawn here.

The marks are trademarks of their owners, shown only to name label sources OSSTrace doesn't have yet.

## Wallet marks in the connect dialog

The Phantom and MetaMask logos in `src/AccountPanel.tsx` (`WalletIcon`) are copied SVG paths from
[Web3 Icons](https://web3icons.io) (`@web3icons/core` 4.0.58, branded wallet icons) by 0xa3k5,
**MIT**, credit kept here. They're trademarks of their projects, shown only to name the wallet.
