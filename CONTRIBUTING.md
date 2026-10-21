# Contributing

Thanks for looking at this. The project is built so you can add one self-contained piece without
needing to understand the whole system first.

## Before you start

1. Read [`ARCHITECTURE.md`](ARCHITECTURE.md) — it's short, and explains the plugin boundaries.
2. Read the `README.md` inside whichever folder you're about to touch — `packages/chains/README.md`
   if you're adding a chain, `packages/features/README.md` if you're adding a feature, etc.
3. If what you want to do doesn't fit either pattern, open an issue/discussion first rather than
   bending the architecture around a one-off — or propose the change as an ADR (see below).

## The non-negotiable rule: sourced data only

Every `Label` and every `Tag` requires a `Source` (a real, checkable URL or named public document,
plus the date you added it). This is enforced by the type system and the ingestion scripts, not
just asked for nicely. A PR that adds label data without a source will be rejected, no exceptions
— this project's entire value is that its data is checkable, and one unsourced entry undermines
that for everything else in the set.

**Also never**: ship a feature backed by mock/fake/placeholder data as if it were real. If
something can't be built for real yet, it belongs in a `README.md`'s "not built" section, not
behind a UI that pretends it works.

## Adding a chain

See [`packages/chains/README.md`](packages/chains/README.md) for the exact steps and the
`ChainAdapter` interface you need to implement.

## Adding a feature

See [`packages/features/README.md`](packages/features/README.md).

## Adding or correcting label data

See [`data/labels/README.md`](data/labels/README.md).

## Code style

- TypeScript, strict mode, no `any` unless you leave a comment saying exactly why.
- No comments explaining *what* code does (the code should read clearly enough on its own) —
  comments are for *why*, when it's non-obvious.
- Real tests for real behavior. Don't mock an entire chain adapter in a test if you can hit a real
  public endpoint instead — see existing tests for the pattern.

## Recording a real architectural decision

If your change is the kind of thing that would be annoying to reverse later (a new storage engine,
a breaking change to the core data model, a new required dependency), add a short file to
`docs/adr/` explaining the decision and why — follow the numbering and format of the existing
ones.

## Commit messages

Describe *why*, not just what changed — the diff already shows what changed.
