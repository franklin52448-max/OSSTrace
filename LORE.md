# OSSTrace: Why This Exists

*A positioning document, not a spec. If you want the architecture, read `ARCHITECTURE.md`. If you want the rules, read `CONTRIBUTING.md` and `FEATURE_GUIDELINES.md`. This is the document for before any of that — what this project is, why it exists, and what it's trying to become.*

---

## The origin story

Arkham built something real: a genuinely useful way to look up a wallet, see what's known about it, and follow where funds moved. For a while, a meaningful slice of that was free to use.

Then Arkham launched a paid "Enterprise" tier and moved previously-free features behind it.

That's the trigger for this project, and it's worth being precise about what kind of trigger it is. It's not outrage, and it's not a grudge. It's the oldest signal in open source: a useful tool got fenced off, so someone built an alternative that can't be fenced off, because nobody owns it. On-chain data is public by definition — every balance, every transaction, every address is sitting on a chain anyone can read. The *idea* of organizing that into something a human can actually use — labels, lookups, tracing, risk context — shouldn't require anyone's permission or anyone's subscription. Arkham proved the idea has value. That doesn't mean Arkham gets to own the idea.

## What this deliberately is not

Say this plainly, because it matters more than almost anything else in this document:

- **This is not a clone of Arkham.** Not its name, not its branding, not its UI, not one byte of its data. Nothing in this repo was built by looking at Arkham's product and copying it feature-for-pixel.
- **This is not affiliated with Arkham in any way** — not a fork, not a partnership, not a tribute. If anything here ever reads like it's trying to pass as Arkham-adjacent, that's a bug to report, not a joke to leave in.
- **This does not and will never scrape Arkham, or any similar proprietary platform, for data.** This isn't a legal technicality we're tiptoeing around — it's load-bearing. [ADR 0004](docs/adr/0004-label-trust-tiers-and-private-labels.md) spells out three independent reasons, and any one of them alone would be enough: it's someone else's protected commercial asset, it defeats the entire premise of this project the instant one uncited entry gets in, and it's a worse long-term strategy anyway — a scraped snapshot rots, a cited pipeline compounds.

What's left after you remove "copy of Arkham" is the actual target: the same *category* of tool — on-chain address and entity lookup, labels, tracing, risk context — built independently, from scratch, open, and owned by no one.

## The core philosophy: two rules, not a mission-statement wall

A lot of projects write a long list of "values" that amount to nothing once code gets written. This one has exactly two rules that are actually enforced, and they're enforced in the type system and the architecture, not in a document someone can ignore under deadline pressure.

**Rule one: a label without a cited, public source is not a label — it's a guess, and it doesn't go in.**

Every `Label` and `Tag` in this codebase carries a non-optional `Source` field — a URL or a named document, plus the date it was added. There is no constructor, no store method, no ingestion script anywhere in `packages/core` that can create one without it ([ADR 0002](docs/adr/0002-labels-require-a-cited-source.md)). This isn't a style preference. The honest options when this project started were: ship with no data, ship with plausible-looking placeholder data, or ship a small amount of real, checkable data. The middle option — fake data that looks real — was never on the table, not because it's against the rules exactly, but because for a project whose *entire value proposition* is "you can check our work," one fabricated entry doesn't just embarrass that entry. It poisons trust in every other entry next to it. A small, real, 89-address seed list is worth infinitely more than a large, plausible, unverifiable one.

**Rule two: this project is built so an outside contributor — human or an AI coding agent — can extend it without reading the whole codebase first.**

This is the primary design goal, not a nice-to-have. Every structural choice in this repo — chains as self-contained plugins behind one `ChainAdapter` interface, features as self-contained plugins that never reach into each other's internals, a `README.md` in every folder that explains itself, ADRs instead of decisions buried in someone's memory or a Slack thread — exists to serve this one goal. The tradeoff rule that falls out of it: if a change makes the project easier to extend but structurally messier, that's usually worth it. If a change makes one feature slightly nicer at the cost of making the next contributor's (or agent's) job harder to understand, it probably isn't worth it.

Why these two, specifically, and not some broader list of generic platitudes ("quality," "community," "transparency")? Because they're the two things that actually compound. Sourcing discipline compounds into a dataset that gets more trustworthy, not less, as it grows. Extensibility discipline compounds into a codebase that gets easier to contribute to, not harder, as it grows. Most projects decay on both axes over time — the data gets murkier, the code gets harder to touch. These two rules are a bet that a project can do the opposite, if the rules are enforced structurally instead of just asked for nicely.

## The long-term mission

Stated directly, because it's the whole point and shouldn't be buried: **build and keep public, forever, the largest openly-licensed labeled wallet/entity database that exists.** Every entry real. Every entry sourced. Free for anyone — a researcher, a journalist, a competing project, a government, a company — to use without asking permission ([ADR 0005](docs/adr/0005-public-labeled-database-is-the-goal.md)).

That's not a feature of this project. It's the thing the code exists to serve.

This is achievable without ever touching Arkham's data, because there's already more legitimate public data than this project has gotten to yet:

- **More government sanctions lists.** OFAC's SDN list is done — it's the real, live seed labelset shipping today. UK OFSI, EU, UN, and Canada's SEMA are the same pattern, waiting to be written as the next ingestion scripts.
- **GitHub-published open address lists** — exchanges and protocols that already publish their own treasury and hot-wallet addresses publicly.
- **Public post-incident security reports** — CertiK, SlowMist, and PeckShield publish hacker and exploit wallet addresses in their own public writeups after an incident, each individually citable.
- **The community contribution pipeline** — eventually the biggest source by volume, once accounts and moderation exist to support it.

Today's labelset is 89 addresses, from one source, across two chains. That's not a milestone to inflate — it's a seed proving the pipeline works, deliberately disclosed as small rather than padded to look further along than it is. Arkham's labelset took years and reportedly billions of rows of attribution work. This project is one day old. The gap between those two numbers isn't a secret; it's the honest starting line.

## The stance on trust

This project runs on the same hard rule the rest of this workspace runs on, taken more seriously here than almost anywhere else it applies: **no mock data, no fake data, no placeholder presented as real, ever** — not even temporarily, not even "just to get the UI working." A transparency tool that fakes its own data isn't a tool with a bug. It's a contradiction of its own reason to exist. If something isn't built yet, it says so in the relevant `README.md`'s "not built" section. It does not hide behind a UI that pretends it works.

Trust, in this project, isn't a feeling — it's a structure, and the structure has tiers ([ADR 0004](docs/adr/0004-label-trust-tiers-and-private-labels.md), designed and locked, not yet built):

- **Community** — anyone can submit a label, as long as it carries a real source. Shown as-is, unreviewed, exactly as sourced.
- **Confirmed** — a project moderator has actually checked a Community label and marked it. A distinct badge, because "submitted with a source" and "verified by someone who checked" are genuinely different claims and shouldn't look the same.
- **Self-attested** — a wallet owner proving control of their own address and labeling it themselves. Deliberately *not* being built yet, because doing it wrong (a spoofing or impersonation hole) is worse than not having it, and it deserves its own focused security pass rather than a bolt-on.

Alongside that: **private labels**, mirroring the one piece of Arkham's own model worth borrowing honestly — a label you add that's visible only to you, with no sourcing requirement, because it's not a public claim. Both tiers need real user accounts, which don't exist yet either. This is written down as a real, sequenced plan, not a feature flag someone forgot to flip.

*Update, 2026-10-23 — what actually happened since the paragraph above was written:* the "Confirmed"
tier and its moderator role were built, then deleted. Self-attestation shipped, but not as its own
bolt-on tier — it became the whole auth model instead: every user now proves control of their
address by wallet signature just to use the product at all (Phantom/MetaMask sign-in replacing the
originally-planned email/password accounts system). Private labels still exist, now authenticated
via that wallet session. There's no moderation concept of any kind today.

The throughline across all of it: a claim this project shows you should always be exactly as trustworthy as it looks, never more, never less.

## Who this is for

This project wants contributors who find "every label needs a real citation or it doesn't ship" satisfying rather than annoying. People — and increasingly, AI coding agents working on people's behalf — who'd rather open one chain folder, read its one README, implement one typed interface, and ship something real than wade through a monolith to make a small change. People who think a small, honest, sourced dataset is worth more than a large, impressive-looking, unverifiable one, and who'd rather see "not built yet" written plainly in a README than a convincing-looking feature that's quietly faking it.

It is explicitly *not* looking for contributors who want to find a clever way around the sourcing rule to pad out coverage faster, or who think the extensibility architecture is bureaucratic overhead rather than the actual point. Those two rules aren't going to bend for a feature that would otherwise ship a week sooner.

## Where it actually stands, today, no spin

Ethereum and Solana chain adapters work against real mainnet RPC — real balances, real transaction history, live-tested, not mocked. The Explorer API and a minimal web UI work end to end. Redis-backed caching and a real background indexer are running and verified across two separate processes. The OFAC seed labelset is real sanctions data, not a stand-in. A batched-RPC fix already replaced a real N+1 performance problem in the Solana adapter.

The Visualizer, the Tracer, risk scoring, case management, accounts and auth, the label moderation workflow, and every chain beyond these first two: not built. Not hidden, not implied, not "coming soon" — just genuinely not built yet, tracked honestly in the README's own status table.

It's early. That's fine to say plainly, because the two rules this project is built on don't need the project to be big to be true — they need it to be real. Today, it is.

*Update, 2026-10-23:* "today" above describes the project's first day. It's no longer that day —
the project has since launched publicly (github.com/OpenTraceIntelligence/OSSTrace,
osstrace.com / opensourcetrace.org), and most of what this paragraph called "not built" — the
Visualizer, Tracer, risk scoring, and an accounts/auth system — has since been built. Case
management was built and then retired from the live site. The accounts/auth system that was built
was later replaced entirely by wallet sign-in, and the label moderation workflow built alongside
it was removed along with it. The two rules this section is really about — real sourcing, real
extensibility — haven't changed; what's built on top of them has. See README.md's status table for
what's current rather than treating this paragraph as live.
