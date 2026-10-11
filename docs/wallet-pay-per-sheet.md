# Wallet / pay-per-sheet — design brainstorm

Status: **v1 implemented on this branch**, pending real-world review. The
open questions below were resolved in conversation and are recorded here as
the decisions actually built, not as options still on the table. See
"What got built" at the end for the concrete shape.

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

### Q1 — What exactly gets billed, and when? — RESOLVED: lock, then capture on first call

Neither of the three options this doc originally proposed, quite. The
actual answer (yours, better than any of the three): **hold the cost at
load time, only make it a real debit when the game's first number gets
called.**

- `handleUpload`/`handleAddSheets` reserve (subtract) the cost immediately
  — insufficient balance is caught *before* a game starts, not discovered
  mid-game or after.
- Nothing is permanently spent yet. Load sheets, never call a number,
  reload something else instead, end an empty session — the reservation
  is released and nothing was ever charged.
- The moment `callNumber`'s first call fires, the reservation becomes a
  real, permanent debit.
- Sheets added via Add Sheets *before* that first call extend the same
  reservation; added *after*, they debit immediately — the game's
  genuinely running by then.
- `showGame()` ("Continue Last Game") never touches any of this — it
  doesn't call `handleUpload`/`handleAddSheets` at all, so resuming a
  saved game can never re-reserve or re-charge what's already accounted
  for, by construction rather than a special case.

### Q2 — How does a recharge get approved? — RESOLVED: manual, admin-dashboard, no self-serve flow

Not the purchase-request/approve flow `api/purchase.js` already has for
subscriptions — deliberately simpler than that. An operator pays the
admin directly (UPI, outside the app) and confirms over WhatsApp/call/
chat, same as today. The admin then types the amount straight into the
Subscribers row — a `+ Balance` action right next to the existing
`+ Time`, same inline-confirm shape, same trust model the rest of this
panel already runs on. No QR code for the wallet itself, no pending-
request queue, no second approval surface to maintain.

This is intentionally the cheap option from the original Q2 writeup — a
real payment gateway (Razorpay/Cashfree/webhook-driven, no admin step at
all) is still the right call *if* recharge volume ever makes manual
crediting the bottleneck, but that's a real integration (API keys, a
webhook endpoint, ~2% fee) worth doing only once it's actually needed.
The wallet's data model doesn't care how a balance got topped up, so
swapping this later costs nothing on the billing-logic side.

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

### Q4 — What happens at zero balance? — RESOLVED, as a side effect of Q1's design

Turned out stricter than any of the three sub-cases this section
originally weighed. Because `lock`/`extend`/`charge` all check affordability
*before* moving any money, and every write clamps at `Math.max(0, …)`, the
balance can never actually go negative — there's no "mid-game overdraft"
state to design a policy for. What happens instead: a game already running
is never interrupted (the check only runs at load/add time, never mid-call),
and the *next* load or Add Sheets attempt is what gets blocked if the
balance can't cover it — which is exactly the "never strand a live event"
outcome this section was reaching for, just arrived at structurally rather
than by a runtime negative-balance policy.

## Status of the original phasing plan

The three branches below were meant to be sequential; in practice Q1–Q4
all resolved together and got built in one pass instead, since the lock/
capture mechanism made most of branch 3 fall out of branch 1's data model
for free. Branch 2 (a self-serve recharge flow) didn't happen at all — Q2
was resolved as "admin-dashboard only," so there's no request/approve
surface to build. What's left of this plan is just the last line:

- **Pilot** on a small number of new operators before this becomes the
  only signup path, so Q5's bet gets tested at low stakes first. Still
  not done — see "What got built" below.

## What got built

- `api/wallet.js` — `lock`/`extend`/`capture`/`charge`/`release`, plus an
  admin-only `history` action for the ledger. One reservation per account
  at a time, stored inline on the subscription record. A device not
  linked to the account (`sub.devices`) can't spend its money.
- `api/subscription.js` — `billingType: 'subscription' | 'wallet'` on the
  same record shape subscriptions already use (same key format, same
  `verify`/device-linking/revoke/reset-devices). `action=create` takes
  `billingType`+`initialBalance` instead of months/days for a wallet
  account; `action=update` takes `addBalance` instead of `extendMonths`.
  A wallet account has no Redis TTL (subscriptions do, sized to their
  expiry) — it has no calendar lifetime to derive one from.
- `api/_subs.js` — `appendWalletTx`, the one shared ledger-append used by
  every debit/credit path, so there's a single transaction shape and cap
  policy rather than two drifting copies.
- `api/config.js` / `api/save-config.js` — `pricePerSheet`, admin-set,
  unset by default. Wallet actions refuse to lock or charge against an
  unset price rather than guessing one.
- `public/index.html` — `walletLockSheets`/`walletExtendOrCharge`/
  `captureWalletLock`/`releaseWalletLock` wired into `handleUpload`,
  `handleAddSheets`, `callNumber`, and `endGame` respectively. Status bar
  shows a live balance (and "₹X locked" while a reservation is open)
  instead of a day countdown for wallet sessions.
- `public/admin/index.html` — a Billing toggle on the create form
  (swaps Duration for Starting Balance), wallet-aware row rendering
  (`₹ balance` instead of a date, "Out of funds"/"running low" reusing
  the existing Expired/Expiring buckets and stat chips rather than adding
  new ones), and `+ Balance`/`− Balance` replacing `+ Time`/`− Time` on a
  wallet row. Settings gained the price-per-sheet field.

**Verified directly against the real handlers** (an in-memory KV mock
standing in for Upstash Redis, driven through an actual HTTP server by
the real browser-rendered client — not hand-rolled fakes): lock → capture
→ charge → release in sequence; a fresh load superseding a still-open
lock from an abandoned session (refunded automatically); insufficient
balance blocking a load *before* anything is committed, leaving an
unrelated still-open lock on the same account untouched; a device not
linked to the account rejected; and — found and fixed during this pass —
the ledger not reconciling line-to-line when a lock was superseded or
captured (balance movement was always correct; the audit trail briefly
wasn't). Re-verified afterward: every transaction type's `amount` now
correctly predicts the next line's `balanceAfter`, checked against a
replayed ledger, not just inspected by eye. The admin panel's own UI
(billing toggle, wallet row, `+ Balance` flow, Settings field) was
clicked through in a real browser against the same server, not just
syntax-checked.

**Not yet done, deliberately**: no pilot has run with a real operator;
the admin's wallet-row ledger/history view (the `history` action exists
server-side, nothing in the UI calls it yet — useful for a support
conversation, built but not surfaced); Q5's anti-gaming bet is still just
a bet, unmeasured.

## What this doc is not

It's not an estimate of gateway fees, not legal/compliance language for
holding customer prepaid balances (worth a sentence to a lawyer once real
money sits in `balance` rather than changing hands same-day), and not a
decision on any of Q1–Q5 — those are yours to make; this just lays out
what each answer costs to build and what it changes.
