# Wallet / pay-per-sheet — design brainstorm

Status: **not implemented yet** — this is the design to react to before any
data-model or billing code gets written. Branch: `wallet-pay-per-sheet`.

## The pivot in one line

Today an operator pays a flat monthly fee (₹499–1499) regardless of volume.
The new model: they prepay a **wallet**, and every sheet they *play* through
the app debits it at an admin-set rate (₹2–5/sheet). A ₹200 top-up buys 100
sheets at ₹2/sheet. Revenue scales with usage instead of being capped by
the subscription tier.

Their own numbers: an operator selling ~2000 sheets/day who runs ~1000 of
them through the app at ₹2 = ₹2000/day from that one operator alone, vs.
≤₹1499/**month** today. Multiple operators selling 5000+/day compound that.
The economics are real *if* the metering and recharge flow can actually
survive that volume without becoming an admin bottleneck — see the open
questions below, which is where this plan could quietly fail.

## What already exists that this builds on

- `tb:config` (`api/config.js` / `api/save-config.js`) — the exact
  admin-configurable-from-dashboard pattern the price-per-sheet setting
  will reuse. `pricingTiers` lives here today; `pricePerSheet` (and a
  low-balance threshold) would sit right next to it.
- `walletCredit` on a subscription (`api/_subs.js`, `api/purchase.js`) —
  **already called "wallet" but is a different thing**: a referral bonus
  that discounts your *next renewal*, capped at that renewal's price, never
  spent per-sheet. The new balance needs its own field name
  (`walletBalance`) so the two don't collide — a subscriber could plausibly
  have both at once under this plan.
- The self-serve purchase flow (`api/purchase.js`, `proceedToPay` /
  `drawBuyQR` / `submitPurchase` in `index.html`) — UPI QR, a pending
  request, admin approves by hand in the Requests tab. This is the
  recharge flow's natural starting point, and also its biggest risk (see
  Q2 below).
- `handleUpload` / `handleAddSheets` (just shipped) — every point where
  sheets enter a live game. These are the only two places "a sheet got
  played" can be measured client-side, which makes them the natural debit
  trigger — see Q1.
- `gameSession.type` is currently always `'subscription'`. A `'wallet'`
  variant is a clean, additive way to carry a balance through the same
  session object the rest of the app already reads (`updateSubStatusBar`,
  `updateWelcomeButtons`, `silentVerifySubscription`'s polling pattern).

## Data model (proposed)

```js
// New KV record, parallel to tb:sub:<key> — a wallet account, not a subscription.
// Keyed the same way (a shareable code) so activation/device-linking reuses
// the exact verify-by-key flow operators already know.
tb:wallet:<key> = {
  key,                        // same shape as a sub key, different prefix: WAL-XXXX-XXXX
  playerName, phone,
  balance: 0,                 // rupees, integer (paise if you want exact accounting later)
  maxDevices, devices: [],    // keep device linking — see Q3 on whether to keep limiting it
  status: 'active' | 'revoked',
  createdAt,
  lowBalanceWarnedAt: null    // last time we nudged them to recharge, for throttling the nudge
}

tb:config.pricePerSheet = 2          // admin-set, rupees, same Settings tab as pricingTiers
tb:config.lowBalanceThreshold = 20   // rupees — when to start warning before blocking

// Append-only ledger — needed for "show me what happened to my money" on both
// sides, and for any dispute. Keep it separate from the wallet record itself
// so the record stays small and the ledger can be paged/archived independently.
tb:wallet_tx:<walletKey> = [
  { id, type: 'debit', sheets: 12, amount: 24, gameRef, at },
  { id, type: 'recharge', amount: 200, reqId, at },
  ...
]
```

## Open questions — these change the shape of the code, not just the copy

### Q1 — What exactly gets billed, and when?

Three real candidates, in order of how much they resemble "pay per sheet
*played*" vs. "pay per sheet *loaded*":

- **(a) Debit on load.** Every sheet that enters `sheets[]` via
  `handleUpload` or `handleAddSheets` debits immediately, success or not
  tied to anything downstream. Simplest to build — it's one call site
  (`parseSheetFiles`'s caller) and nothing else in the game loop needs to
  know about money. Weakness: an operator who loads 150 sheets for a game
  that only 80 players actually show up for pays for 150. A misclick
  (load, realize wrong file, reload) double-charges unless reload also
  refunds the replaced batch.
- **(b) Debit on first number called that hits that sheet.** Closer to
  "played" — a loaded-but-never-marked sheet costs nothing. Needs
  `callNumber` to know about billing (it currently doesn't touch the
  network at all), and needs a batched/debounced debit so you're not
  firing a billing API call on every single number call across every
  sheet — probably "debit any newly-touched sheets once per `callNumber`
  tick" rather than per-ticket.
- **(c) Debit at `endGame()` for whatever sheets were loaded in that
  session.** One debit per game instead of N, easy to show as a single
  line in the wallet ledger ("Diwali Night — 42 sheets — ₹84"). Weakness:
  the balance isn't checked *before* sheets are loaded, so you can't block
  a game from starting on insufficient funds — you'd find out you're
  overdrawn only at the end, which is the worst possible moment to tell
  an operator they can't download/keep their results.

My read: **(a), with an explicit "undo on reload"** — simplest, matches
"pay per sheet number they play per sheet" in the literal sense of your
message, and it's the one `handleUpload`/`handleAddSheets` are already
built to support cleanly (they're the only two places that touch `sheets`
at all). (c) is worth a look if "billed once per game, like a tab" reads
better to operators than "billed the instant I click load," but it means
balance can go negative mid-game, which needs its own decision (see Q4).

### Q2 — How does a recharge get approved?

This is the one most likely to break the business case, not just the UX.
The current purchase flow is **manual by design** — the code comment is
explicit that a UPI deep link has no webhook, so "paid" is never trusted
automatically, only admin-confirmed. That was fine for monthly renewals:
maybe a few dozen approvals a day across all subscribers.

A wallet model inverts the frequency. If an operator runs 1000 sheets/day
at ₹2, a ₹200 top-up lasts them *one hundred sheets* — a few hours, maybe
less on a busy night. At real multi-operator volume this is tens of
manual-approval clicks a day, every day, forever — the admin becomes the
bottleneck the wallet model was supposed to remove, and a stalled
approval means a host staring at a blocked app mid-event.

Two ways out:
- **Keep manual approval, but batch the pain** — nudge operators to
  recharge in bigger chunks (₹500+ instead of ₹100) so approvals stay
  infrequent even at high sheet volume. Zero integration work, but it's a
  policy nudge, not a fix — it caps the problem, doesn't remove it.
- **Add a real payment gateway with a webhook** (Razorpay/Cashfree/PhonePe
  PG — any of them do UPI collect + webhook). Recharges confirm themselves
  in seconds, no admin step at all. This is real integration work (API
  keys, a webhook endpoint, reconciliation, ~2% gateway fee eating into
  the margin your own math is counting on) but it's what actually makes
  "pay as you go" live up to the name at the volume you're describing.

I'd want to build the wallet's *data model* gateway-agnostic either way
(balance, ledger, debit logic — none of that cares how the balance got
topped up), so this can start manual and swap to a gateway later without
touching the billing logic at all. But which one you want determines how
much of this first branch is "ship it" vs. "ship the plumbing, gateway
is phase 2" — worth deciding now rather than discovering it under load.

### Q3 — Does the wallet replace subscriptions, or sit alongside them?

Existing subscribers have paid-for time left on the clock. Three options:
- **New operators default to wallet; existing subscribers keep their
  subscription until it naturally expires, then choose.** No migration,
  no refunds, `gameSession.type` just grows a second value and both paths
  coexist indefinitely if some operators genuinely prefer flat-fee
  predictability over metered cost.
- **Hard cutover**, converting remaining subscription time to a wallet
  credit at some conversion rate. Needs a refund-math decision and will
  need explaining to existing subscribers.
- **Operator's choice per-account**, with an admin toggle to switch a
  given key between models. Most flexible, the most to build.

I'd default to the first — cheapest, safest, and it also quietly works as
the pilot in Q5 below (new signups are the test group).

### Q4 — What happens at zero balance?

Three sub-cases, each with a different right answer:
- **Before a game starts** (loading the first sheet with ₹0 balance) —
  block cleanly, send them to recharge. Easy, no controversy.
- **Mid-game** (balance hits zero after sheet #40 of a 50-sheet load, or
  via Q1(c)'s end-of-game debit) — blocking outright strands a live event
  in front of players. I'd let the current game finish regardless of
  balance (even running negative) and only block the *next* load/game
  start until they recharge. Operators should never be the ones holding a
  dead app in front of a room of players mid-draw.
- **Negative balance carrying forward** — does it block all future play
  until cleared, or just warn? I'd block new sheet loads but keep the
  app usable (view results, download sheets already played) so a negative
  balance isn't also a data-access cliff.

### Q5 — Anti-gaming: the 2000-vs-1000 gap is the business model's soft spot

Your own framing — "operator sells 2000/day, say 1000 are played through
my software" — already names the gap: the app only bills what passes
*through it*. An operator who notices billing is per-sheet-loaded has an
obvious lever: load fewer sheets into the app (call numbers off a paper
list for the rest) and keep the difference. That's not a bug to patch,
it's the actual shape of the incentive this model creates, worth having a
clear answer for even if the honest answer is "most operators won't
bother, the convenience of the app is worth more than the per-sheet cost"
— I'd rather that be a stated bet than an unexamined assumption.

## Suggested phasing

1. **Branch 1 (this one): data model + admin controls only.** Wallet
   record, ledger, `pricePerSheet`/threshold in Settings, admin wallet
   list (balance, recent debits) parallel to the existing subscriptions
   list. No debit logic wired into the game loop yet — nothing user-facing
   changes. Low-risk, reviewable on its own, and it's where Q1–Q4 get
   locked in before anything touches real money.
2. **Branch 2: recharge flow.** Reuses `api/purchase.js`'s request/approve
   shape with a `type:'wallet-recharge'` request, manual approval to
   start (per Q2) — or a gateway integration if that's the call.
3. **Branch 3: debit wiring.** Hook into `handleUpload`/`handleAddSheets`
   (Q1), the low-balance banner (parallel to `updateRenewNotice`), and the
   zero-balance gate (Q4).
4. **Pilot** on a small number of new operators before this becomes the
   only signup path, so Q5's bet gets tested at low stakes first.

## What this doc is not

It's not an estimate of gateway fees, not legal/compliance language for
holding customer prepaid balances (worth a sentence to a lawyer once real
money sits in `balance` rather than changing hands same-day), and not a
decision on any of Q1–Q5 — those are yours to make; this just lays out
what each answer costs to build and what it changes.
