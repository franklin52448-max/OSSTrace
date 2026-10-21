# Chains

Each subfolder here is a self-contained chain integration implementing `ChainAdapter` from
`@opentrace/core`. Nothing in one chain's folder should ever import from another chain's folder.

## The contract

```ts
interface ChainAdapter {
  readonly chain: ChainId;
  getBalance(address: string): Promise<Balance>;
  getRecentTransactions(address: string, limit: number): Promise<TransactionsResult>;
}
```

- `getBalance` must return a real, freshly-fetched balance — never a cached/stale/placeholder
  value passed off as current.
- `getRecentTransactions` returns `{ available: false, reason }` (not an empty array, not a
  thrown error) when the data genuinely can't be fetched — e.g. a required API key isn't
  configured. Callers need to tell "nothing happened" apart from "we couldn't check."
- Don't invent fields. If a chain's data source can't give you a `from`/`to` for some transaction
  shape (e.g. a Solana instruction this adapter doesn't decode), say so in the adapter's own
  README rather than guessing.

## Adding a new chain

1. `mkdir packages/chains/<chain-name>` with the same shape as `ethereum/` or `solana/`
   (`package.json`, `tsconfig.json`, `src/adapter.ts`, `tests/`, `README.md`).
2. Add `"<chain-name>"` to the `ChainId` union in `packages/core/src/types.ts` — this is the one
   line outside your folder you need to touch.
3. Implement `ChainAdapter` against a real data source. No mocked responses, no stub values
   pretending to be real.
4. Register your adapter in `packages/features/explorer/src/registry.ts`.
5. Write a `README.md` in your folder: what RPC/API it talks to, what (if anything) needs an API
   key, and what it genuinely can't do yet.
6. Add this package to the `workspaces` list in the root `package.json` (it's a glob —
   `packages/chains/*` — so this is usually automatic) and to `tsconfig.json`'s `references`.

## Currently implemented

- [`ethereum/`](ethereum/README.md) — balance via public JSON-RPC; transaction history via the
  Etherscan v2 API (needs a free API key).
- [`solana/`](solana/README.md) — balance and transaction history via public RPC, no API key
  needed.
