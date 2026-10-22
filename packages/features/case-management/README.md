# @osstrace/case-management

Case management ([ADR 0011](../../../docs/adr/0011-case-management-private-owner-only-cases.md)):
a signed-in user groups findings into a structured record they own. A **case** has a title, a
description and an open/closed status. It holds **items**. Each item is one real address on a
supported chain, plus the investigator's own note about why it's in the case.

**A case is private to its owner. Nobody else can ever see it: not other users, not moderators,
not admins.** No API route, role or parameter reads or changes someone else's case. A case is
also not a public claim, so neither the case nor its notes need a source. ADR 0002's sourcing rule
doesn't apply, for the same reason it doesn't apply to private labels (ADR 0004). If a finding
should become public, the path is a sourced Community label submission (ADR 0007), not a public
case. Read ADR 0011 for why: no sharing in v1, and no admin read path.

## Running it

```sh
npm run dev:cases      # from the repo root
# or
npm run dev --workspace packages/features/case-management
```

Listens on `CASES_PORT` (default **5314**). It needs the accounts API (`npm run dev:accounts`, port
5310) for signup and login. It authenticates sessions against the same accounts file
(`ACCOUNTS_STORE_PATH`, default `data/private/accounts.json`) and only ever reads that file.
Cases are stored in `data/private/cases.json`, or wherever `CASES_PATH` points (relative paths
resolve from the repo root). That folder is git-ignored, and the file is created `0600`. Browser
access is limited to the origins in `CASES_ALLOWED_ORIGINS`. If that's unset, it uses
`ACCOUNTS_ALLOWED_ORIGINS`, then `http://localhost:5301`.

## API

Every route needs `Authorization: Bearer <session token>` from `/accounts/login` or
`/accounts/signup`. The owner of every operation is always the user that token belongs to. No path
segment, query parameter, header or body field can name a different user. Extra fields such as an
`ownedBy`, `userId` or `id` in the body are ignored. **Someone else's case id gets exactly the same
`404` as an id that doesn't exist**, so the API can't be used to probe which case ids exist.
Responses are `Cache-Control: no-store, private` and `Vary: Origin, Authorization`, and they
never include an owner id.

| Route | Body | Success |
|---|---|---|
| `GET /cases?status=open\|closed` | none | `200 { cases: CaseSummary[] }` (yours, most recently worked on first) |
| `POST /cases` | `{ title, description? }` | `201 { case }` |
| `GET /cases/:id` | none | `200 { case, items: CaseItem[] }` (items in the order added) |
| `PATCH /cases/:id` | `{ title?, description? }` (at least one) | `200 { case }` |
| `DELETE /cases/:id` | none | `204`. Deletes the case and all its items; there is no undo |
| `POST /cases/:id/close` | none | `200 { case }` |
| `POST /cases/:id/reopen` | none | `200 { case }` |
| `POST /cases/:id/items` | `{ chain, address, note? }` | `201 { item }` |
| `PATCH /cases/:id/items/:itemId` | `{ note }` (`""` clears it) | `200 { item }` |
| `DELETE /cases/:id/items/:itemId` | none | `204` |

- `case` is `{ id, title, description, status: "open" | "closed", createdAt, updatedAt, closedAt }`.
  `closedAt` is `null` while the case is open. `updatedAt` moves on any change, including item
  changes.
- `CaseSummary` is a `case` plus `itemCount`.
- `item` is `{ id, caseId, chain, address, note, addedAt, updatedAt }`.

Errors are `{ "error": "<code>", "message": "..." }`. Messages never echo the request path or your
input back.

- `unauthenticated` → 401. This is checked before anything else, so an anonymous caller learns
  nothing, not even whether their input was well-formed.
- `invalid_case`, `invalid_item`, `invalid_chain`, `invalid_address`, `bad_request` → 400.
- `not_found` → 404 (no such case *for you*, or no such item in it).
- `case_closed` → 409. The case is closed, so it's read-only until reopened. Closing an
  already-closed case also returns this.
- `case_not_closed` → 409. You tried to reopen a case that's already open.
- `duplicate_item` → 409. That address is already in this case; edit its note instead.
- `limit_reached` → 409.
- `method_not_allowed` → 405.
- A body over 64 KiB → 413.

**Addresses** are checked with `isRealAddress` and stored with `canonicalAddress` from
`@osstrace/core`, the same checks community-labels and Tracer use. A malformed address is
rejected. Ethereum addresses are lowercased, because checksum case isn't part of the address.
Solana addresses are kept exactly as given, because base58 is case-sensitive. Surrounding
whitespace is trimmed first. One case holds a given `(chain, address)` once, whichever way it was
spelled. The same address can be in as many *different* cases as you like.

**Text**: a title is one line of 1–140 characters, with whitespace runs collapsed. A description
(up to 8,000) and a note (up to 2,000) may be empty and may span lines. Control characters other
than newline and tab are refused. Lengths count Unicode code points, not bytes.

**Limits**: 500 cases per account, 1,000 items per case. Both are counted inside the store's write
lock, so concurrent requests can't overshoot them.

```sh
curl -X POST localhost:5314/cases -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Bridge exploit follow-up","description":"Where did the funds go?"}'
curl -X POST localhost:5314/cases/$CASE_ID/items -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"chain":"ethereum","address":"0x00000000219ab540356cbb839cbe05303d7705fa","note":"first hop"}'
```

## How it plugs in

- **`@osstrace/accounts`** (public API only): `AccountService.authenticate()` answers "whose
  request is this?", and `bearerToken()` reads the header. The service depends on a one-method
  `Authenticator` interface. That means this package can't create users, issue sessions or change
  roles. It also never calls `requireRole`, because no role grants any power over someone else's
  case.
- **`@osstrace/core`**: `ChainId`, `AccountId`, and the shared address checks
  `isChainId` / `isRealAddress` / `canonicalAddress`.
- **`createCasesHandler(service)`** returns `false` for paths outside `/cases`. It's the same
  mountable shape as `createAccountsHandler` and `createBountiesHandler`.
- **Web UI** (`packages/web`): the **Cases** tab (`src/CasesView.tsx`, `#cases`), shown to everyone
  but usable only when logged in.

### Data model and storage

Cases and their items are two collections in one JSON file, the same layout as bounties and their
submissions. Items reference their case by `caseId`. Every item also carries `ownedBy`,
duplicated from its case, so the store filters items by owner *and* case. `JsonFileCaseStore` has
the same concurrency contract as the other stores here:

- it re-reads the file on every call;
- it serializes writes in-process;
- it writes atomically (temp file + rename), so deleting a case and its items is one write.

## How isolation is enforced

1. **The store's interface can't express "someone else's case".** Every `CaseStore` method takes
   the owner's id. There's no lookup by case id alone and no list-everything method. An empty owner
   id throws instead of acting as a wildcard, and `createCase` refuses a case owned by anyone but
   the caller.
2. **The service takes the owner only from the authenticated session.** No method has an owner
   parameter, and none consults a role.
3. **Not-yours looks like not-there.** A probe of another user's case id returns the same `404`
   body as a random id.
4. **The HTTP layer never echoes request paths or input** into error messages. Responses are
   uncacheable and vary on `Authorization`.
5. **The web UI tags fetched state with the session it was fetched for**, the same as
   `PrivateLabelPanel`. Switching accounts in one browser can't flash the previous user's cases.

## Testing

`npm test` runs `tests/store.test.ts`, `tests/service.test.ts` and `tests/http.test.ts`, all against
real code. Each test uses a real temp-file case store and the real `AccountService` with real argon2
hashing. The HTTP tests use one real HTTP server on an ephemeral port that mounts both the accounts
routes and these routes, called with `fetch`. The only test hooks are an injectable clock and
lowered limits. The adversarial isolation tests have `ISOLATION:` in their names. They check:

- Another user can't read, list, edit, close, reopen, delete, add to, or edit or remove items in
  your case. That holds for a plain user, a **moderator** and an **admin**, by every route.
- Each of those probes returns a response byte-identical to the same probe on a nonexistent id.
- Naming the owner in a query parameter, header or body field doesn't work. Path tricks
  (traversal, encoded slashes, ids as segments) don't work either.
- An intruder's own case can't be used as a doorway to your item ids.
- No byte of your title, description, notes or account id appears in any response an intruder
  receives.
- Your case is byte-for-byte unchanged afterwards, and on disk it's stored under your id only.
- Logged-out, forged and expired sessions are refused (`401`) on every route before any
  validation.
- Many users building cases at the same time each see only their own.

Also covered: the full lifecycle (closed cases refuse every change until reopened), canonical
address storage and duplicate detection across spellings, every validation rule, limits under
concurrency, `0600`/`0700` file permissions, re-reads across store instances, cascade delete, CORS
and cache headers, and status codes.

## What's not built yet

- **Sharing.** No collaborators, teams, read-only links or public cases. This is deliberate for v1
  (ADR 0011 §2). Sharing needs its own ADR before it's built.
- **"Publish" a case as Community label submissions.** A finding goes public only through
  community-labels, with a real source, one address at a time, by hand.
- **Adding to a case from the Lookup, Graph or Trace views.** You add an address on the Cases tab
  by pasting it. There's no "add to case" button next to a looked-up address yet.
- **Live data inside a case.** An item stores the address and your note only. It doesn't snapshot
  or show the address's balance, label or transactions; look the address up for that.
- **Attachments, tags, transaction-hash items, or export** (CSV/JSON) of a case.
- **Soft delete or undo.** Deleting a case is permanent.
- **Case cleanup on account deletion.** Accounts can't be deleted yet (ADR 0006). When they can,
  that user's cases and items must be deleted too.
- **Rate limiting.** The per-account limits bound storage, not request rate.
- **One writer process.** Several server instances on one file need a database-backed
  `CaseStore`. It's the same interface, so nothing else would change.
- **Encryption at rest.** The file is `0600`, but whoever runs the server can read it. That's the
  same trust model as the accounts and private-labels files, stated in ADR 0011 §3.
