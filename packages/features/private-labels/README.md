# @opentrace/private-labels

Private labels ([ADR 0004](../../../docs/adr/0004-label-trust-tiers-and-private-labels.md)): any
signed-in user can put their own free-text label on an address, like "my cold wallet" or "scammer
from discord". **Nobody else ever sees it.** It needs no source, because it isn't a public claim,
so ADR 0002's sourcing rule doesn't apply. This mirrors Arkham's private-by-default custom labels.

A private label is **not** a `Label` from `@opentrace/core`. It's a separate type in a separate
store, keyed by `(userId, chain, address)`. It never goes into `data/labels/`, the Explorer's
`/address` response, or the Explorer's Redis cache. Promoting one into a public Community label (a
"share" action) is not built. If it gets built, the promoted label would need a real source like
any other public label.

## Running it

```sh
npm run dev:private-labels      # from the repo root
```

Listens on `PRIVATE_LABELS_PORT` (default 5311). It needs the accounts API
(`npm run dev:accounts`, port 5310) for signup and login, and it authenticates sessions against the
same accounts file (`ACCOUNTS_STORE_PATH`, default `data/private/accounts.json`). Labels are stored
in `data/private/private-labels.json`, or wherever `PRIVATE_LABELS_STORE_PATH` points. That folder
is git-ignored, and the file is created `0600`. Browser access is limited to the origins in
`PRIVATE_LABELS_ALLOWED_ORIGINS`. If that's unset, it uses `ACCOUNTS_ALLOWED_ORIGINS`, then
`http://localhost:5301`.

## API

Every route needs `Authorization: Bearer <session token>` from `/accounts/login` or
`/accounts/signup`. The owner of every operation is always the user that token belongs to. No path
segment, query parameter, header or body field can name a different user. Extra fields such as a
`userId` in the body are ignored. Responses are `Cache-Control: no-store, private` and
`Vary: Origin, Authorization`, and they never include an owner id.

| Route | Body | Success |
|---|---|---|
| `GET /private-labels` | none | `200 { labels: PrivateLabel[] }` (yours, newest first) |
| `GET /private-labels/:chain/:address` | none | `200 { label: PrivateLabel \| null }` |
| `PUT /private-labels/:chain/:address` | `{ label }` | `201 { label, created: true }` or `200 { label, created: false }` |
| `DELETE /private-labels/:chain/:address` | none | `204`, or `404 not_found` if you had none |

`PrivateLabel` is `{ chain, address, label, createdAt, updatedAt }`. Errors are
`{ "error": "<code>", "message": "..." }`:
- `unauthenticated` → 401. This is checked before anything else, so an anonymous caller learns nothing.
- `invalid_chain`, `invalid_address`, `invalid_label`, `bad_request` → 400.
- `not_found` → 404.
- `limit_reached` → 409.
- A body over 4 KiB → 413.

**Addresses** are stored in one canonical form. Ethereum addresses are lowercased, because hex case
is only an EIP-55 checksum, and the Explorer does the same. Solana addresses are kept exactly as
given, because base58 is case-sensitive. A malformed address is rejected instead of being stored
under a key nobody will ever look up.

**Labels** are free text: trimmed, 1–200 characters (counted as Unicode code points), one line, no
control characters. Each account can hold up to 5,000, which bounds how large the re-read-every-call
file can grow.

```sh
curl -X PUT localhost:5311/private-labels/ethereum/0x00000000219ab540356cbb839cbe05303d7705fa \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"label":"my cold wallet"}'
```

## How it plugs in

- **`@opentrace/accounts`** (public API only): `AccountService.authenticate()` answers "whose
  request is this?", and `bearerToken()` reads the header. The service depends on a one-method
  `Authenticator` interface, so this package can't create users, issue sessions or change roles.
  The default path for the accounts file is mirrored in `src/bootstrap.ts` rather than imported,
  because the accounts package doesn't export its resolver. This server only reads that file. It
  never writes it, so the accounts store's one-writer assumption still holds.
- **`@opentrace/core`**: just the `ChainId` type.
- **`createPrivateLabelsHandler(service)`** returns `false` for paths outside `/private-labels`,
  the same mountable shape as `createAccountsHandler`.
- **Web UI** (`packages/web`): `PrivateLabelPanel.tsx` (per address) and `AccountBar.tsx` (log in
  or sign up, and your private labels).

### Why its own package instead of folding it into accounts

Accounts answers "who are you, and what may you do?". It's a foundation that several features build
on (Confirmed-tier moderation, private labels, Case Management later). Private labels are a
feature built on that answer. If they lived inside accounts, every future consumer of accounts
would carry label storage and routes it doesn't need, and the accounts file would hold more than
credentials. It also keeps the isolation property easy to audit: everything that touches private
labels is in this one folder.

## How isolation is enforced

1. **The store's interface can't express "someone else's label".** Every `PrivateLabelStore` method
   takes the owner's `userId`. There's no lookup by address alone and no list-everything method.
   An empty `userId` throws instead of acting as a wildcard.
2. **The service takes the owner only from the authenticated session.** No method has an owner
   parameter.
3. **The HTTP layer never echoes request paths or other input** into error messages. Responses are
   uncacheable and vary on `Authorization`.
4. **The web UI tags fetched state with the session it was fetched for**, so switching accounts in
   one browser can't flash the previous user's label for even one frame.
   `tests/http.test.ts` and a real-browser check (see "Testing") cover this.

## Testing

`npm test` runs 24 tests, all against real code. There's a real temp-file store, the real
`AccountService` with real argon2 hashing, and one real HTTP server on an ephemeral port that
mounts both the accounts routes and these routes, called with `fetch`. The only test hook is an
injectable clock. The adversarial isolation tests (`ISOLATION:` in the names) check:
- User A can't read, list, overwrite or delete user B's labels by any route, through case variants
  of the address, by naming B in a query parameter, header or body field, or with path tricks.
- No byte of B's label text or B's account id appears in any response A receives.
- Logged-out, forged and expired sessions can't read or change anything.
- Many users writing the same address at the same time each read back only their own label.

## What's not built here yet

- **Share / promote to a Community label**: designed in ADR 0004, not built.
- **Private labels in the Graph tab**: only the Lookup view shows your label.
- **Bulk import/export** of your own labels.
- **Label cleanup on account deletion.** Accounts can't be deleted yet (ADR 0006). When they can,
  that user's private labels must be deleted too.
- **One writer process.** Several server instances on one file need a database-backed
  `PrivateLabelStore`. It's the same interface, so nothing else would change.
- **Encryption at rest.** The file is `0600`, but whoever runs the server can read it. That's the
  same trust model as the accounts file.
