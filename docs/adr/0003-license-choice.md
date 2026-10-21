# ADR 0003 — AGPL-3.0-only license

Status: Decided 2026-10-21

## Context

A permissive license (MIT/Apache-2.0) would let anyone — including a well-funded competitor —
take this project, run it as a closed, hosted SaaS product, and never contribute improvements
back. For a project whose entire point is public, auditable on-chain transparency tooling, that
outcome (a closed fork becoming the de facto popular version) would undermine the founding goal.

## Decision

License the project AGPL-3.0-only. The key property beyond regular GPL: the AGPL's network-use
clause means that even running a modified version as a hosted web service (not just distributing
the code) triggers the obligation to offer source to that service's users. That specifically
closes the "SaaS loophole" that plain GPL doesn't cover.

## Consequences

- Some companies avoid AGPL code in commercial products on principle, which may reduce certain
  kinds of adoption/integration. Accepted tradeoff — this project optimizes for staying open over
  maximizing adoption by closed-source integrators.
- Every source file should eventually carry a short license header once the project has a public
  home; the root `LICENSE` file is authoritative in the meantime.

## What would change this decision

If the project's goals shift toward "get this logic embedded everywhere, including closed
products" rather than "keep this specific tool and its data open," MIT/Apache-2.0 would fit that
goal better. That's a deliberate, future, from-scratch decision — not a default to drift into.
