/* Self-serve purchase / renewal requests.

   Payment verification stays manual on purpose — a UPI deep link has no
   webhook, so there's no way to trust "paid" automatically. What this
   removes is the OTHER manual step: the admin hand-typing a player's
   name/duration/devices and copy-pasting a key back to them every single
   time someone subscribes or renews.

   A player picks one of the admin's configured price tiers (tb:config.
   pricingTiers, see api/config.js), pays via UPI, and submits a request.
   The admin sees it in the Requests tab and approves with one click — the
   server does all the typing from there: generates/extends the key,
   applies any referral reward or wallet credit, and the player's own poll
   picks up the result automatically. No WhatsApp round trip needed.       */
const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const { genSubKey, genReferralCode, advanceExpiry, pickUnique } = require('./_subs');
const kv = Redis.fromEnv();

const REQ_KEY = 'tb:purchase_requests';
const REF_KEY = 'tb:referrals';
const REFERRAL_REWARD = 100;          // rupees credited to the referrer
const REQUEST_TTL_MS = 6 * 60 * 60 * 1000;   // an unapproved request goes stale after 6h

function genReqId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

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

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── GET: admin lists pending + recent requests, and the referral ledger ── */
  if (req.method === 'GET') {
    if (await rateLimit(req, 'listreqs2', 60, 60))
      return res.status(429).json({ error: 'Too many requests' });
    const { password } = req.query;
    if (!checkPassword(password, process.env.ADMIN_PASSWORD))
      return res.status(401).json({ error: 'Wrong password' });
    const [list, ledger] = await Promise.all([kv.get(REQ_KEY), kv.get(REF_KEY)]);
    return res.json({ requests: (list || []).slice(0, 200), referrals: (ledger || []).slice(0, 200) });
  }

  if (req.method !== 'POST') return res.status(405).end();
  const { action } = req.body || {};

  /* ── POST action=request: player submits a purchase/renewal request ── */
  if (action === 'request') {
    if (await rateLimit(req, 'purchreq', 10, 3600))
      return res.status(429).json({ error: 'Too many requests. Try again later.' });

    const { type, playerName, phone, planId, referralCode, existingKey } = req.body;
    if (type !== 'new' && type !== 'renew')
      return res.status(400).json({ error: 'Invalid request type' });

    const tiers = await loadTiers();
    const plan = tiers.find(t => t.id === planId);
    if (!plan) return res.status(400).json({ error: 'That plan is no longer available. Please pick again.' });

    const name = String(playerName || 'Player').trim().slice(0, 50);
    const cleanPhone = String(phone || '').replace(/\D/g, '').slice(0, 15);

    let existingSub = null;
    if (type === 'renew') {
      const clean = String(existingKey || '').toUpperCase().trim().replace(/[^A-Z0-9-]/g, '');
      existingSub = clean ? await kv.get(`tb:sub:${clean}`) : null;
      if (!existingSub) return res.status(404).json({ error: 'Your subscription key was not found. Please contact admin.' });
    }

    // wallet credit only ever applies to your OWN renewal — a brand new
    // purchaser has no subscription (and so no credit) yet
    const credit = type === 'renew' ? Math.min(existingSub.walletCredit || 0, plan.price) : 0;
    const amount = Math.max(0, plan.price - credit);

    // a referral code only means anything for a genuinely new purchaser
    let cleanReferral = null;
    if (type === 'new' && referralCode) {
      cleanReferral = String(referralCode).toUpperCase().trim().slice(0, 20);
    }

    const request = {
      id: genReqId(), type, planId, planLabel: plan.label, price: plan.price,
      credit, amount, playerName: name, phone: cleanPhone,
      referralCode: cleanReferral, existingKey: type === 'renew' ? existingSub.key : null,
      status: 'pending', createdAt: Date.now()
    };

    const list = await kv.get(REQ_KEY) || [];
    list.unshift(request);
    await kv.set(REQ_KEY, list.slice(0, 500));

    return res.json({ ok: true, reqId: request.id, amount, credit });
  }

  /* ── POST action=check: player polls for approval ── */
  if (action === 'check') {
    if (await rateLimit(req, 'purchcheck', 500, 3600))
      return res.status(429).json({ error: 'Too many requests' });
    const { reqId } = req.body;
    if (!reqId) return res.status(400).json({ error: 'reqId required' });

    const list = await kv.get(REQ_KEY) || [];
    const r = list.find(x => x.id === reqId);
    if (!r) return res.status(404).json({ error: 'Request not found' });

    if (r.status === 'pending' && Date.now() - r.createdAt > REQUEST_TTL_MS)
      return res.json({ status: 'expired' });

    return res.json({
      status: r.status,
      key: r.resultKey || null, expiresAt: r.resultExpiresAt || null,
      plan: r.planLabel, reason: r.reason || null
    });
  }

  /* ── POST action=cancel: player backs out of a pending request ── */
  if (action === 'cancel') {
    const { reqId } = req.body;
    if (!reqId) return res.status(400).json({ error: 'reqId required' });
    const list = await kv.get(REQ_KEY) || [];
    const r = list.find(x => x.id === reqId);
    if (r && r.status === 'pending') { r.status = 'cancelled'; r.resolvedAt = Date.now(); await kv.set(REQ_KEY, list); }
    return res.json({ ok: true });
  }

  /* ── admin: approve / reject ── */
  if (action === 'approve' || action === 'reject') {
    if (await rateLimit(req, 'purchresolve', 60, 3600))
      return res.status(429).json({ error: 'Too many requests' });
    const { password, reqId } = req.body;
    if (!checkPassword(password, process.env.ADMIN_PASSWORD))
      return res.status(401).json({ error: 'Wrong password' });

    const list = await kv.get(REQ_KEY) || [];
    const r = list.find(x => x.id === reqId);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    if (r.status !== 'pending')   // idempotent: a double-click is a no-op, not a double-charge
      return res.json({ ok: true, action: r.status, alreadyResolved: true });

    if (action === 'reject') {
      r.status = 'rejected';
      r.reason = String(req.body.reason || 'Payment not confirmed. Please try again or contact us.').slice(0, 200);
      r.resolvedAt = Date.now();
      await kv.set(REQ_KEY, list);
      return res.json({ ok: true, action: 'rejected' });
    }

    const tiers = await loadTiers();
    const plan = tiers.find(t => t.id === r.planId);
    if (!plan) return res.status(400).json({ error: 'That plan no longer exists — cannot approve as-is.' });

    if (r.type === 'new') {
      const name = r.playerName;
      const key = await pickUnique(kv, 'tb:sub:', genSubKey);
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
      await kv.set(REQ_KEY, list);
      return res.json({ ok: true, action: 'approved', key, expiresAt });
    }

    // type === 'renew'
    const sub = await kv.get(`tb:sub:${r.existingKey}`);
    if (!sub) return res.status(404).json({ error: 'That subscription no longer exists.' });

    sub.expiresAt = advanceExpiry(sub.expiresAt, plan);
    sub.months = plan.months; delete sub.days;
    sub.maxDevices = plan.maxDevices;
    if (sub.status === 'revoked') sub.status = 'active';
    if (r.credit > 0) sub.walletCredit = Math.max(0, (sub.walletCredit || 0) - r.credit);
    await saveSub(sub);

    r.status = 'approved'; r.resultKey = sub.key; r.resultExpiresAt = sub.expiresAt; r.resolvedAt = Date.now();
    await kv.set(REQ_KEY, list);
    return res.json({ ok: true, action: 'approved', key: sub.key, expiresAt: sub.expiresAt });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
