# @osstrace/core

The shared data model and plugin interfaces. Every other package imports from here; this package
imports from nothing chain- or feature-specific.

## What's in here

- **`src/types.ts`** — `Address`, `Label`, `Tag`, `Entity`, `Source`, `Balance`,
  `TransactionSummary`, `TokenTransfer`. See the file's own doc comments; the shapes are explained
  there, not duplicated here. `TransactionSummary.tokenTransfers` is an optional, additive field
  added for ERC-20/SPL decoding. It's backward compatible: it's absent whenever a chain decoded
  no token movement, and no existing field changed meaning (`valueNative` is still native-only).
  `TransactionSummary.timestamp` is `string | null`: `null` means the chain didn't report when the
  transaction happened, and it is never filled in with a made-up date. Consumers must handle it:
  it fails any time filter, sorts as least recent, and is shown as unknown — never passed to
  `new Date(...)`, which turns `null` into 1970. See ADR 0016.
- **`src/chainAdapter.ts`** — the `ChainAdapter` interface every chain package implements.
- **`src/store.ts`** — `LabelStore` interface + `JsonFileLabelStore`, a file-backed implementation.
  See the file's docstring for why JSON-file rather than a database for v1.

## If you're adding a chain or a feature

You don't need to change anything in this package. Import what you need from `@osstrace/core`
and implement/consume the interfaces. If you find yourself wanting to *change* a type here,
that's a cross-cutting decision — flag it in a PR description or an ADR, since it affects every
other package.

## Testing

`npm test` in this folder runs real tests against a real temp-file-backed store (see
`tests/store.test.ts`) — no mocking of the store itself, since the store's whole job is file I/O
correctness.
