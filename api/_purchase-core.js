/* Approve / reject logic for purchase + renewal requests, shared by the admin
   web panel (api/purchase.js) and the Telegram approval buttons
   (api/telegram.js) so the two can never drift apart. */
const { Redis } = require('@upstash/redis');
const { genSubKey, genReferralCode, advanceExpiry, pickUnique } = require('./_subs');
const tg = require('./_telegram');
const kv = Redis.fromEnv();

const REQ_KEY = 'tb:purchase_requests';
const REF_KEY = 'tb:referrals';
const REFERRAL_REWARD = 100;                     // rupees credited to the referrer
const DRAFT_TTL_MS = 6 * 60 * 60 * 1000;         // a request nobody paid/sent proof for goes stale after 6h
const PENDING_TTL_MS = 72 * 60 * 60 * 1000;      // a submitted request waits up to 72h for the admin
const PENDKEY_TTL_S = 72 * 60 * 60 + 3600;

function genReqId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

async function loadTiers() {
  const cfg = await kv.get('tb:config') || {};
  return Array.isArray(cfg.pricingTiers) ? cfg.pricingTiers : [];
}

async function saveSub(sub) {
  await kv.set(`tb:sub:${sub.key}`, sub);
  const list = await kv.get('tb:subscriptions') || [];
  const idx = list.findIndex(s => s.key === sub.key);
  if (idx >= 0) list[idx] = sub; else list.unshift(sub);
  await kv.set('tb:subscriptions', list.slice(0, 500));
}

/* Rewrites the Telegram message with the outcome (best effort). */
async function closeTelegramMessage(r, line) {
  if (!r.tgMsg) return;
  const base = r.tgCaption || `${r.playerName} · ${r.planLabel}`;
  await tg.finalize(r.tgChat, r.tgMsg, `${base}\n\n${line}`, !!r.tgPhoto);
  delete r.tgCaption;   // no longer needed once the buttons are gone
}

/* → { http, body }. `via` is just a label for the Telegram line. */
async function resolveRequest(reqId, action, reason, via) {
  // Two near-simultaneous presses (Telegram + panel, or a double tap) must not
  // both create a subscription / pay a referral reward.
  const lock = `tb:lock:req:${reqId}`;
  const got = await kv.set(lock, 1, { nx: true, ex: 30 });
  if (!got) return { http: 200, body: { ok: true, action: 'in-progress', alreadyResolved: true } };
  try { return await resolveLocked(reqId, action, reason, via); }
  finally { await kv.del(lock).catch(() => {}); }
}

async function resolveLocked(reqId, action, reason, via) {
  const list = await kv.get(REQ_KEY) || [];
  const r = list.find(x => x.id === reqId);
  if (!r) return { http: 404, body: { error: 'Request not found' } };
  if (r.status !== 'pending')   // idempotent: a repeat press is a no-op, not a double-charge
    return { http: 200, body: { ok: true, action: r.status, alreadyResolved: true, status: r.status } };

  if (action === 'reject') {
    r.status = 'rejected';
    r.reason = String(reason || 'Payment not confirmed. Please try again or contact us.').slice(0, 200);
    r.resolvedAt = Date.now();
    if (r.reservedKey) await kv.del(`tb:pendkey:${r.reservedKey}`);
    if (r.utr) await kv.del(`tb:utr:${r.utr}`);    // let them retry with the same real payment
    await closeTelegramMessage(r, `❌ REJECTED (${via}) — ${r.reason}`);
    await kv.set(REQ_KEY, list);
    return { http: 200, body: { ok: true, action: 'rejected' } };
  }

  const tiers = await loadTiers();
  const plan = tiers.find(t => t.id === r.planId);
  if (!plan) return { http: 400, body: { error: 'That plan no longer exists — cannot approve as-is.' } };

  if (r.type === 'new') {
    const name = r.playerName;
    // The key was handed to the player when they sent the request; approval
    // is what switches it on. (Older requests have no reserved key.)
    let key = r.reservedKey;
    if (!key || await kv.exists(`tb:sub:${key}`)) key = await pickUnique(kv, 'tb:sub:', genSubKey);
    const referralCodeForNewSub = await pickUnique(kv, 'tb:ref:', () => genReferralCode(name));
    const expiresAt = advanceExpiry(Date.now(), plan);

    const subscription = {
      key, playerName: name, phone: r.phone,
      maxDevices: plan.maxDevices, devices: [], status: 'active', createdAt: Date.now(), expiresAt,
      months: plan.months, referralCode: referralCodeForNewSub, walletCredit: 0,
      purchasedVia: 'self-serve'
    };
    await saveSub(subscription);
    await kv.set(`tb:ref:${referralCodeForNewSub}`, key);
    await kv.del(`tb:pendkey:${key}`);

    // referral reward: only for a genuinely new subscriber, only once,
    // never for someone referring themselves (cheap phone-match guard)
    if (r.referralCode) {
      const referrerKey = await kv.get(`tb:ref:${r.referralCode}`);
      const referrer = referrerKey ? await kv.get(`tb:sub:${referrerKey}`) : null;
      if (referrer && !(referrer.phone && referrer.phone === r.phone)) {
        referrer.walletCredit = (referrer.walletCredit || 0) + REFERRAL_REWARD;
        await saveSub(referrer);
        const ledger = await kv.get(REF_KEY) || [];
        ledger.unshift({
          id: genReqId(), referrerKey: referrer.key, referrerName: referrer.playerName,
          referredKey: key, referredName: name, amount: REFERRAL_REWARD, createdAt: Date.now()
        });
        await kv.set(REF_KEY, ledger.slice(0, 500));
      }
    }

    r.status = 'approved'; r.resultKey = key; r.resultExpiresAt = expiresAt; r.resolvedAt = Date.now();
    await closeTelegramMessage(r, `✅ APPROVED (${via}) — ${key} is now active`);
    await kv.set(REQ_KEY, list);
    return { http: 200, body: { ok: true, action: 'approved', key, expiresAt } };
  }

  // type === 'renew'
  const sub = await kv.get(`tb:sub:${r.existingKey}`);
  if (!sub) return { http: 404, body: { error: 'That subscription no longer exists.' } };

  sub.expiresAt = advanceExpiry(sub.expiresAt, plan);
  sub.months = plan.months; delete sub.days;
  sub.maxDevices = plan.maxDevices;
  /* A fresh renewal cycle gets a fresh device count. Without this, a
     subscriber who lost/changed a device (or whose subscription lapsed
     and got logged out) renews, then finds their OWN first device
     rejected as "device limit reached" — the slot is still held by a
     stale device id from before. Any device still in regular use just
     re-registers itself on its next verify. */
  sub.devices = [];
  if (sub.status === 'revoked') sub.status = 'active';
  if (r.credit > 0) sub.walletCredit = Math.max(0, (sub.walletCredit || 0) - r.credit);
  await saveSub(sub);

  r.status = 'approved'; r.resultKey = sub.key; r.resultExpiresAt = sub.expiresAt; r.resolvedAt = Date.now();
  await closeTelegramMessage(r, `✅ APPROVED (${via}) — ${sub.key} renewed`);
  await kv.set(REQ_KEY, list);
  return { http: 200, body: { ok: true, action: 'approved', key: sub.key, expiresAt: sub.expiresAt } };
}

module.exports = { REQ_KEY, REF_KEY, DRAFT_TTL_MS, PENDING_TTL_MS, PENDKEY_TTL_S, genReqId, loadTiers, saveSub, resolveRequest };
