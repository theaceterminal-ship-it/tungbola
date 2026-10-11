/* Pay-per-sheet metering for wallet-type subscriptions.

   Mechanics (see docs/wallet-pay-per-sheet.md for the full brainstorm):
     lock    — sheets are about to be loaded into a game that hasn't started
               calling numbers yet. Reserves (subtracts) the cost against the
               balance immediately, so insufficient funds is caught BEFORE a
               game starts, but nothing is permanently spent yet.
     extend  — more sheets added (Add Sheets) before any number has been
               called in this session — grows the same pending lock.
     capture — the game's first number gets called. The pending lock becomes
               a real, permanent debit. No further balance movement — the
               money already left the balance at lock time; this just
               converts "reserved" into "spent" in the ledger.
     charge  — sheets added via Add Sheets AFTER the first call — the game is
               genuinely underway, so this debits immediately rather than
               extending a lock.
     release — the operator backs out before calling anything (reloads a
               different game, ends an empty session) — the lock is undone
               and the full amount returns to the balance. "Continue Last
               Game" never calls any of this at all, since it doesn't touch
               handleUpload/handleAddSheets — resuming a saved game can never
               re-lock or re-charge what was already accounted for.

   One lock per account at a time, stored inline on the subscription record
   (sub.pendingLock) rather than a separate key — there's realistically only
   ever one live game session per operator, and keeping it on the same record
   means a single kv.get/set per call instead of two.                      */

const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const { appendWalletTx } = require('./_subs');
const kv = Redis.fromEnv();

async function loadPricePerSheet() {
  const cfg = await kv.get('tb:config') || {};
  return Number.isFinite(cfg.pricePerSheet) && cfg.pricePerSheet > 0 ? cfg.pricePerSheet : null;
}

async function loadWallet(key) {
  const clean = String(key || '').toUpperCase().trim().replace(/[^A-Z0-9-]/g, '');
  if (!clean) return { error: 'Subscription key required' };
  const sub = await kv.get(`tb:sub:${clean}`);
  if (!sub) return { error: 'Subscription not found', status: 404 };
  if (sub.billingType !== 'wallet') return { error: 'Not a wallet account', status: 400 };
  if (sub.status === 'revoked') return { error: 'This account has been cancelled.', status: 410 };
  return { clean, sub };
}

async function saveWallet(clean, sub) {
  await kv.set(`tb:sub:${clean}`, sub);
  const list = await kv.get('tb:subscriptions') || [];
  const idx = list.findIndex(s => s.key === clean);
  if (idx >= 0) { list[idx] = sub; await kv.set('tb:subscriptions', list); }
}

// A device not linked to this account can't spend its money — same check
// api/subscription.js's verify does when it registers a new device, kept in
// sync here rather than trusting whatever deviceId a request happens to send.
function deviceOk(sub, deviceId) {
  return typeof deviceId === 'string' && sub.devices.includes(deviceId);
}

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  if (await rateLimit(req, 'wallettx', 120, 3600))
    return res.status(429).json({ error: 'Too many requests' });

  const { action, key, deviceId, sheets } = req.body || {};

  /* ── lock: fresh load (handleUpload) — replaces any previous lock ── */
  /* ── extend: more sheets before the first call (handleAddSheets, pre-call) ── */
  if (action === 'lock' || action === 'extend') {
    const { clean, sub, error, status } = await loadWallet(key);
    if (error) return res.status(status || 400).json({ error });
    if (!deviceOk(sub, deviceId)) return res.status(403).json({ error: 'Device not linked to this account' });

    const n = Math.max(0, Math.min(150, parseInt(sheets, 10) || 0));
    if (!n) return res.status(400).json({ error: 'sheets required' });

    const price = await loadPricePerSheet();
    if (price == null) return res.status(503).json({ error: 'Per-sheet pricing is not set up yet — ask the admin to set it in Settings.' });

    // Every ledger line's `amount` is always just the money THIS call moved
    // — never a total folded in with an implicit prior refund — so the
    // ledger reconciles step by step without the reader needing to know any
    // of this function's internal rules. `extend` recomputes the running
    // total from scratch (priorSheets + n) for sizing the new lock, but the
    // actual balance movement and the ledger line it writes are only ever
    // the cost of the newly added `n`. `lock` always starts a fresh session
    // (handleUpload just wiped the old game) — if a DIFFERENT lock was still
    // outstanding (operator reloaded a different file without ending the
    // old session first), that gets refunded here too, as its OWN ledger
    // line, same as an explicit release, before the new lock's own line.
    const refund = sub.pendingLock ? sub.pendingLock.amount : 0;
    const priorSheets = action === 'extend' && sub.pendingLock ? sub.pendingLock.sheets : 0;
    const totalSheets = priorSheets + n;
    const incrementalCost = n * price;             // what THIS call newly reserves
    // `extend` isn't releasing anything — the prior lock's sheets stay
    // covered by it — so only the balance actually sitting free can pay for
    // the newly added sheets. `lock` releases the old (different) lock
    // first, so that refund is also available to cover the new one.
    const available = (sub.walletBalance || 0) + (action === 'lock' ? refund : 0);

    if (incrementalCost > available) {
      return res.status(409).json({
        error: `Not enough balance — ${n} more sheet${n !== 1 ? 's' : ''} at ₹${price} needs ₹${incrementalCost}, ₹${available} available.`,
        shortBy: incrementalCost - available, pricePerSheet: price, balance: sub.walletBalance || 0
      });
    }

    if (action === 'lock' && refund > 0) {
      sub.walletBalance = (sub.walletBalance || 0) + refund;
      await appendWalletTx(kv, clean, {
        type: 'lock-superseded', amount: refund, sheets: sub.pendingLock.sheets, balanceAfter: sub.walletBalance
      });
    }

    sub.walletBalance = (sub.walletBalance || 0) - incrementalCost;
    sub.pendingLock = { amount: totalSheets * price, sheets: totalSheets, pricePerSheet: price, createdAt: Date.now() };
    await saveWallet(clean, sub);
    await appendWalletTx(kv, clean, {
      type: action === 'extend' ? 'lock-extended' : 'lock', amount: -incrementalCost, sheets: n,
      totalLockedSheets: totalSheets, balanceAfter: sub.walletBalance
    });

    return res.json({ ok: true, locked: sub.pendingLock.amount, totalSheets, balance: sub.walletBalance });
  }

  /* ── capture: first number of the session just got called ── */
  if (action === 'capture') {
    const { clean, sub, error, status } = await loadWallet(key);
    if (error) return res.status(status || 400).json({ error });
    if (!deviceOk(sub, deviceId)) return res.status(403).json({ error: 'Device not linked to this account' });

    if (!sub.pendingLock) return res.json({ ok: true, captured: 0, balance: sub.walletBalance || 0 });

    // The money already left the balance back at lock/extend time — this
    // only finalizes the reservation into a permanent debit, it does not
    // move the balance again. amount:0 on the ledger line reflects that
    // literally, so the ledger's running total never has to know this rule
    // to reconcile: every line is still exactly balanceBefore + amount.
    const lock = sub.pendingLock;
    sub.pendingLock = null;
    await saveWallet(clean, sub);
    await appendWalletTx(kv, clean, {
      type: 'capture', amount: 0, sheets: lock.sheets, lockedAmount: lock.amount, balanceAfter: sub.walletBalance || 0
    });

    return res.json({ ok: true, captured: lock.amount, sheets: lock.sheets, balance: sub.walletBalance || 0 });
  }

  /* ── charge: sheets added mid-game, after the first call ── */
  if (action === 'charge') {
    const { clean, sub, error, status } = await loadWallet(key);
    if (error) return res.status(status || 400).json({ error });
    if (!deviceOk(sub, deviceId)) return res.status(403).json({ error: 'Device not linked to this account' });

    const n = Math.max(0, Math.min(150, parseInt(sheets, 10) || 0));
    if (!n) return res.status(400).json({ error: 'sheets required' });

    const price = await loadPricePerSheet();
    if (price == null) return res.status(503).json({ error: 'Per-sheet pricing is not set up yet — ask the admin to set it in Settings.' });

    const cost = n * price;
    if (cost > (sub.walletBalance || 0)) {
      return res.status(409).json({
        error: `Not enough balance — ${n} more sheet${n !== 1 ? 's' : ''} at ₹${price} needs ₹${cost}, ₹${sub.walletBalance || 0} available.`,
        shortBy: cost - (sub.walletBalance || 0), pricePerSheet: price, balance: sub.walletBalance || 0
      });
    }

    sub.walletBalance = (sub.walletBalance || 0) - cost;
    await saveWallet(clean, sub);
    await appendWalletTx(kv, clean, { type: 'debit', amount: -cost, sheets: n, balanceAfter: sub.walletBalance });

    return res.json({ ok: true, charged: cost, balance: sub.walletBalance });
  }

  /* ── release: backed out before any number was called — give the lock back ── */
  if (action === 'release') {
    const { clean, sub, error, status } = await loadWallet(key);
    if (error) return res.status(status || 400).json({ error });
    if (!deviceOk(sub, deviceId)) return res.status(403).json({ error: 'Device not linked to this account' });

    if (!sub.pendingLock) return res.json({ ok: true, released: 0, balance: sub.walletBalance || 0 });

    const lock = sub.pendingLock;
    sub.walletBalance = (sub.walletBalance || 0) + lock.amount;
    sub.pendingLock = null;
    await saveWallet(clean, sub);
    await appendWalletTx(kv, clean, {
      type: 'lock-released', amount: lock.amount, sheets: lock.sheets, balanceAfter: sub.walletBalance
    });

    return res.json({ ok: true, released: lock.amount, balance: sub.walletBalance });
  }

  /* ── admin: ledger for a wallet account (Subscribers panel detail view) ── */
  if (action === 'history') {
    const { password } = req.body;
    if (!checkPassword(password, process.env.ADMIN_PASSWORD))
      return res.status(401).json({ error: 'Wrong password' });
    const clean = String(key || '').toUpperCase().trim().replace(/[^A-Z0-9-]/g, '');
    if (!clean) return res.status(400).json({ error: 'key required' });
    const list = await kv.get(`tb:wallet_tx:${clean}`) || [];
    return res.json({ transactions: list.slice(0, 100) });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
