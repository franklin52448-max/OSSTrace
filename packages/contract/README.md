# @osstrace/contract

The shared contract for `packages/server`: domain types, deterministic ids, and the pure op
reducers that drive the investigation canvas and the visualizer's saved views. See
[ADR 0022](../../docs/adr/0022-unified-server-replaces-the-per-feature-services.md) for why this
package exists alongside `packages/core` (the old architecture's equivalent).

- **`src/types.ts`** — `Chain`, `AddressInfo`, `Transfer` (decimal-string amounts, nullable USD,
  never floats), `Trace`/`TraceNode`/`TraceEdge`/`TraceOp` (the canvas), `VisualizerState`/
  `VisualizerOp` (saved views).
- **`src/ids.ts`** — UUIDv5 ids over `ID_NAMESPACE` (this project's own namespace constant — never
  reuse another project's, or ids could collide), EIP-55 checksumming, chain detection.
- **`src/reducers.ts`** — `applyTraceOps`/`applyVisualizerOps`: pure, idempotent; an op referencing
  a missing id is skipped, never an error; positions/fields use last-writer-wins on
  `clientTimestamp`. The server applies these authoritatively; the web UI will replay them
  optimistically against the same functions, so the two can never drift.
- **`src/api.ts`** — every request/response type, with the route list in comments above each group.
  Treat it as this system's OpenAPI.

## Tests

```sh
npm run test --workspace packages/contract   # vitest — see ADR 0022 §4 for why this package uses vitest, not node --test
```
