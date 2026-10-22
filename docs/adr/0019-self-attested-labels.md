# ADR 0019 — Self-attested labels (tier 3): signed by the address's own key

Status: Decided 2026-10-22. Server side implemented in `packages/features/community-labels/`
(`selfAttestation.ts`, `LabelSubmissionService.requestSelfAttestation` /
`submitSelfAttestation`) and `@osstrace/core` (`SelfAttestedLabel`). **No wallet-connect UI yet.**
See "Not built" below.

## Context

ADR 0004 designed a third label tier and deferred it: "a wallet owner cryptographically proves
control of their own address (a signed message) and labels it themselves", noting it "needs real
security design (proving ownership without opening a spoofing/impersonation hole)". This ADR is
that design. It gets its own ADR, separate from ADR 0017 (share flow and rate limit), because
almost every decision in it is a security decision with its own threat model.

What a self-attestation can and can't prove matters more than how it's built:

- **It proves** that whoever submitted it held the private key of that address when they signed.
  That's a stronger signal about *who is making the claim* than any third party's word.
- **It does not prove** the name is true. Anyone can generate a wallet and self-attest it as
  "Binance Hot Wallet". Owners also have the strongest incentive to describe their own address
  flatteringly. So a self-attestation is evidence of control, never of identity.

## Decision

### 1. Challenge → sign → verify, with the message built only by the server

1. `POST /labels/submissions/self-attested/challenge` (logged in) with `{ chain, address, name }`.
   The server validates the address and the name (the same rules as any submission:
   `parseTarget`, `parseLabelName` in `validate.ts`) and returns `{ nonce, scheme, message,
   expiresAt }`.
2. The person signs `message` with the address's key in their wallet.
3. `POST /labels/submissions/self-attested` with `{ nonce, signature }`. The server looks up the
   challenge by nonce and verifies the signature over **its own copy** of the message.

The client never sends the message, so it can't swap in a different statement. The message is
plain text, one field per line, in the spirit of Sign-In with Ethereum (EIP-4361), so the wallet's
signing prompt shows the person exactly what they're vouching for:

```
<domain> wants you to self-attest a public label for an address you control.

I control this address, and I publicly label it as shown below. This is not a transaction and costs nothing.

Chain: ethereum
Address: 0x…
Label: <name>
OSSTrace account: <account id>
Nonce: <32 hex chars>
Issued At: <ISO 8601>
Expiration Time: <ISO 8601>
```

Each line closes a specific hole:

- **Label** is inside the signature. The signer vouches for that exact name, and nobody can
  re-use the signature for a different one. The name has already been through the plain-text
  rules: whitespace collapsed, control and bidi characters refused. So it can't add a forged
  second `Address:` line to the statement (tested).
- **OSSTrace account** binds the signature to the account that asked. Someone who sees your
  signature can't submit it under their own account (the nonce is also account-bound, below).
- **Nonce** (128 random bits, server-issued) makes every signature single-use and fresh.
- **Domain** (`SELF_ATTESTATION_DOMAIN`, the web UI's host) names which site asked for the
  signature, so a phishing page asking for one shows the wrong site name in the prompt.
- **"This is not a transaction"** is for the person reading the wallet prompt.

### 2. Challenges: single-use, 10-minute expiry, bound to one account, in memory

`ChallengeBook` holds issued challenges in memory. A challenge:

- **expires after 10 minutes**, enough time to open a wallet and sign;
- is **used up by any redeem attempt by its own account**, whether or not the signature then
  checks out, so a nonce can never be tried twice;
- **can only be redeemed by the account that requested it**. Another account presenting it gets
  `invalid_attestation`, and the challenge stays usable by its owner, so a leaked nonce can't be
  burned by someone else;
- is capped at **5 outstanding per account** (asking for a 6th drops that account's oldest) and
  10,000 overall, so issuing challenges can't grow memory without bound.

In memory is enough. A restart loses the outstanding challenges, and the person asks for a new
one. Nothing in a challenge is worth persisting, and nothing in it is a secret.

### 3. Verification: standard wallet schemes, existing audited libraries, no hand-rolled crypto

`verifySelfAttestation(chain, address, message, signature): boolean`:

- **Ethereum — EIP-191 `personal_sign`**, what MetaMask and every EOA wallet produce. The hash is
  keccak256("\x19Ethereum Signed Message:\n" + UTF-8 byte length + message). The signature is
  65-byte r‖s‖v hex, with v as 27/28 or 0/1. The public key is *recovered* from the signature,
  and its address (last 20 bytes of keccak256 of the key) must equal the claimed address.
  High-s signatures (the malleated twin of a valid one, which no real wallet produces) are refused.
- **Solana — Ed25519 over the message's raw UTF-8 bytes**, what wallet-standard `signMessage`
  (Phantom, Solflare, Backpack) produces. A Solana address *is* its 32-byte Ed25519 public key in
  base58, so verification is direct. The signature is 64 bytes, base58.

Libraries: `@noble/curves` (secp256k1, ed25519) and `@noble/hashes` (keccak-256), both audited and
already in this monorepo, since `@solana/web3.js` is built on them. Also `bs58`, the base58 codec
`@solana/web3.js` uses. This package now declares them directly, at the versions already
installed. No new package was added to the tree. `ethers` isn't a dependency anywhere here, and
pulling it in for one `verifyMessage` call wasn't worth it when the primitives were already
present. The code builds the exact bytes each standard signs and hands them to these libraries.
The tests pin those bytes against published vectors: the Ethereum address of private key 1,
ethers' `hashMessage("hello world")`, and RFC 8032's Ed25519 test 1. So the check isn't only
"our signer agrees with our verifier".

Any malformed input (bad hex, bad base58, wrong length, a point not on the curve) returns
`false`. It never throws.

### 4. The data model: a fourth submission status, a third submitted-label variant

Following ADR 0007 section 1 (the `Label` union, with `reviewStatus` only on labels a person
submitted):

- `@osstrace/core`: `ReviewStatus` gains `"self-attested"`. `SelfAttestedLabel` is a new
  `SubmittedLabel` variant with `reviewStatus: "self-attested"`, `submissionId`, `submittedBy`,
  `submittedAt`, plus `attestation: { scheme, message, signature }`. `isSubmittedLabel` covers it.
  `IngestedLabel` is unchanged and still forbids `reviewStatus`.
- `@osstrace/community-labels`: `SubmissionStatus` gains `"self-attested"`, with
  `SelfAttestedSubmission` stored in the same submissions file, through the same
  `SubmissionStore.create`.

**The source (ADR 0002).** Every label needs a cited, checkable source, and this one is the
signature itself. `source.description` says what was signed and checked, and that it proves
control rather than truth. `source.url` points at this ADR (the methodology). The label also
carries `attestation`, so **anyone can re-verify it independently** with any EIP-191 or Ed25519
implementation, without trusting this server. That's more checkable than a URL a moderator has
to read. `confidence` is `"verified"`, because the signed statement states the claim outright.

### 5. Display and moderation: shown at once, ranked last, removable, not "confirmable"

- **Public immediately** once the signature verifies, badged **SELF-ATTESTED · SIGNED BY OWNER**.
  The tooltip spells out "proves who is speaking, not that the label is true". The signed
  statement can be expanded under the label.
- **Ranked below sourced community claims** in `CommunityLabelReader`: confirmed, then community,
  then self-attested. This is the impersonation answer. If someone files a sourced report ("phishing
  wallet impersonating Binance, see this incident write-up") against an address whose owner
  self-attested "Binance Hot Wallet", the public sees the report, not the owner's own description.
  An unreviewed third-party claim can still hide an honest owner's self-attestation, and
  moderation fixes that: rejecting the bad claim brings the owner's label back. Ingested
  official labels still outrank everything (ADR 0007).
- **Moderators can reject** a self-attestation (`listForReview(…, "self-attested")` lists them),
  which takes it out of public view like any rejection. The attestation is kept on the rejected
  record for audit.
- **Moderators can't "confirm"** one (`not_confirmable`, 409). Confirming means "a moderator
  checked the cited source". A self-attestation's evidence is a signature the server already
  checked. Re-using the badge would make it mean two things, the same reasoning ADR 0007 used for
  ingested labels.
- **Re-attesting is allowed.** The "one pending submission per account per address" rule is for
  the review queue. A newer self-attestation for the same address simply shows instead of the
  older one. It counts toward the rate limit (ADR 0017), and that's what bounds it.

## Not built (real follow-ups, not done here)

- **A wallet-connect UI.** There's no in-browser "connect wallet and sign" flow yet. The API is
  complete (request a challenge, sign it with any wallet or CLI, submit), and the web UI already
  *displays* self-attested labels and their signed statements. Building the signing UI means
  picking a wallet integration (EIP-1193 `personal_sign` for Ethereum, wallet-standard
  `signMessage` for Solana), and that's a separate, user-facing piece of work.
- **Smart-contract wallets (EIP-1271), e.g. a Safe.** They don't have a key that can produce an
  EOA signature. Verifying one means calling `isValidSignature` on-chain, which needs an RPC call
  and the signing contract's deployment state. Today an EIP-1271 signature just fails
  verification. It's never accepted wrongly.
- **Solana's off-chain message format** (the `\xffsolana offchain` header). Not every wallet
  supports it, and raw `signMessage` is what wallets do today. A human-readable message that
  can't parse as a transaction is also safe to sign raw.
- **Attesting about a *different* address you control** (a hot wallet vouching for a cold one)
  is out of scope. You can only self-attest the address that signs.
- **Revoking** your own self-attestation. Today a newer one replaces it, or a moderator removes it.

## What would change this decision

- If impersonation through self-attestation turns out to be common, take the label out of public
  view until a moderator approves it, so it becomes reviewable rather than immediate. The data
  model already supports that, since only the reader's display rules would change.
- If wallets converge on SIWE-style or off-chain-message standards for this kind of statement,
  switch the message format to match, so wallet prompts render it natively. The `scheme` field on
  each attestation keeps old ones re-verifiable.
