# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[Security Advisories](https://github.com/OpenTraceIntelligence/OSSTrace/security/advisories/new)
("Report a vulnerability" under this repo's Security tab), not as a public issue or PR. That opens
a private thread with the maintainer where details, reproduction steps, and a fix can be worked
out before anything is disclosed publicly.

This is a small, actively-developed open-source project with no dedicated security team — reports
are handled best-effort, with no formal SLA. In practice, expect an initial response within a few
days. Confirmed vulnerabilities will get a fix and a coordinated disclosure once one's available;
we'll credit the reporter unless they'd rather stay anonymous.

## Scope

**In scope** — the code the live site (`osstrace.com`) actually runs on:
- `packages/server` — auth (wallet sign-in, session handling), the bounty deposit-verification
  flow, webhook SSRF protections, and every other route it exposes.
- `packages/web` — the frontend that talks to it.
- `packages/contract` — the shared API types between them.

**Out of scope** — `packages/features/*` (the nine original standalone services this project
migrated off of). They're not reachable from the live site; some are kept running only for a few
tests that deliberately exercise retired components against them (see
[ADR 0022](docs/adr/0022-unified-server-replaces-the-per-feature-services.md)'s Consequences
section for exactly which). A report against one of these is still welcome, just not urgent in the
same way a live-site finding is.

## What this project does and doesn't custody

Worth knowing up front, since it shapes what counts as a security issue here: this project never
holds, escrows, or moves funds on a visitor's behalf, and wallet sign-in only ever signs a
*message* to prove address ownership, never a transaction. The one exception is Bounties
([ADR 0020](docs/adr/0020-bounty-funding-via-verified-on-chain-deposits.md)): a visitor can
optionally send a real on-chain payment to a wallet the project operator controls to back a
bounty. That wallet receiving funds is real and worth scrutiny (sender verification, replay
protection, access control on who can record a deposit against which bounty) — but there's no
escrow or release logic to audit, because none exists; payout is manual and off-platform by
design, not a gap.
