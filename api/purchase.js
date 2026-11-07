/* Self-serve purchase / renewal requests.

   Flow: the player picks a plan (a 'draft' request is created, which also
   fixes the price), pays by UPI, then sends the payment screenshot. The
   screenshot goes straight to the admin's Telegram with Approve / Reject
   buttons and is never stored by us. For a new buyer, their subscription key
   is generated at that moment and shown to them straight away — it only
   starts working once the admin approves. The player's app polls `check`
   and activates by itself when the approval lands.

   Payment verification stays manual on purpose: a UPI deep link has no
   webhook, so "paid" can't be trusted automatically. The admin can approve
   from Telegram or from the web panel — both call the same resolveRequest(). */
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const { genSubKey, pickUnique } = require('./_subs');
const tg = require('./_telegram');
const core = require('./_purchase-core');
const kv = Redis.fromEnv();

const { REQ_KEY, DRAFT_TTL_MS, PENDING_TTL_MS, PENDKEY_TTL_S, genReqId, loadTiers, resolveRequest } = core;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;   // the app shrinks to ~1MB first; Vercel's body limit is 4.5MB

/* Don't trust the client's claimed type — check the file's own magic bytes. */
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
const esc = s => String(s == null ? '' : s);

function findOwned(list, reqId, token) {
  const r = list.find(x => x.id === reqId);
  if (!r || !r.token || !checkPassword(token, r.token)) return null;   // wrong/missing token looks like "not found"
  return r;
}

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── GET: admin lists requests that need attention, and the referral ledger ── */
  if (req.method === 'GET') {
    if (await rateLimit(req, 'listreqs2', 60, 60))
      return res.status(429).json({ error: 'Too many requests' });
    const { password } = req.query;
    if (!checkPassword(password, process.env.ADMIN_PASSWORD))
      return res.status(401).json({ error: 'Wrong password' });
    const [list, ledger] = await Promise.all([kv.get(REQ_KEY), kv.get(core.REF_KEY)]);
    // drafts (picked a plan, never sent proof) and cancelled ones are noise for the admin
    const visible = (list || []).filter(r => r.status !== 'draft' && r.status !== 'cancelled')
      .map(({ token, tgCaption, ...rest }) => rest);
    return res.json({ requests: visible.slice(0, 200), referrals: (ledger || []).slice(0, 200) });
  }

  if (req.method !== 'POST') return res.status(405).end();
  const { action } = req.body || {};

  /* ── POST action=request: player picks a plan → draft request + price ── */
  if (action === 'request') {
    if (await rateLimit(req, 'purchreq', 40, 3600))
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

    // wallet credit only ever applies to your OWN renewal
    const credit = type === 'renew' ? Math.min(existingSub.walletCredit || 0, plan.price) : 0;
    const amount = Math.max(0, plan.price - credit);

    let cleanReferral = null;
    if (type === 'new' && referralCode) cleanReferral = String(referralCode).toUpperCase().trim().slice(0, 20);

    const request = {
      id: genReqId(), token: crypto.randomBytes(16).toString('hex'),
      type, planId, planLabel: plan.label, price: plan.price,
      credit, amount, playerName: type === 'renew' ? existingSub.playerName : name, phone: cleanPhone,
      referralCode: cleanReferral, existingKey: type === 'renew' ? existingSub.key : null,
      status: 'draft', createdAt: Date.now()
    };

    // keep the list lean: stale drafts and cancelled requests are dropped on write
    const now = Date.now();
    const list = (await kv.get(REQ_KEY) || []).filter(r =>
      r.status !== 'cancelled' && !(r.status === 'draft' && now - r.createdAt > DRAFT_TTL_MS));
    list.unshift(request);
    await kv.set(REQ_KEY, list.slice(0, 500));

    return res.json({ ok: true, reqId: request.id, token: request.token, amount, credit });
  }

  /* ── POST action=proof: player sends the payment screenshot for approval ── */
  if (action === 'proof') {
    if (await rateLimit(req, 'purchproof', 15, 3600))
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    if (!tg.configured())
      return res.status(503).json({ error: 'Approval service is not set up yet. Please contact admin.' });

    const { reqId, token, image } = req.body;
    let utr = String(req.body.utr || '').trim().toUpperCase();
    if (utr && !/^[A-Z0-9]{8,30}$/.test(utr))
      return res.status(400).json({ error: 'Transaction ID looks wrong — check it, or leave it blank.' });

    const list = await kv.get(REQ_KEY) || [];
    const r = findOwned(list, reqId, token);
    if (!r) return res.status(404).json({ error: 'Request not found. Please start again.' });

    // idempotent: a double tap (or a retry after a slow network) gets the same answer
    if (r.status === 'pending' && r.proofAt) return res.json({ ok: true, key: r.reservedKey || r.existingKey, already: true });
    if (r.status !== 'draft' && r.status !== 'pending')
      return res.status(409).json({ error: 'This request is already closed. Please start a new one.' });
    if (r.status === 'draft' && Date.now() - r.createdAt > DRAFT_TTL_MS)
      return res.status(410).json({ error: 'This request expired. Please start again.' });

    // screenshot is mandatory unless wallet credit covers the whole price
    let buffer = null, mime = null;
    if (r.amount > 0 || image) {
      const data = image && typeof image.data === 'string' ? image.data : '';
      buffer = data ? Buffer.from(data, 'base64') : null;
      if (!buffer || !buffer.length) return res.status(400).json({ error: 'Attach your payment screenshot.' });
      if (buffer.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'Screenshot is too large.' });
      mime = sniffImage(buffer);
      if (!mime) return res.status(400).json({ error: 'That file is not a picture. Attach a screenshot (JPG/PNG).' });
    }

    if (utr) {
      const used = await kv.get(`tb:utr:${utr}`);
      if (used && used !== r.id) return res.status(409).json({ error: 'This transaction ID was already used for another request.' });
    }

    const reservedKey = r.type === 'new'
      ? await pickUnique(kv, 'tb:sub:', genSubKey, 10, k => kv.exists(`tb:pendkey:${k}`))
      : null;

    const keyLine = r.type === 'new' ? `🔑 New key: ${reservedKey}` : `🔑 Renewing: ${r.existingKey}`;
    const caption = [
      r.type === 'new' ? '🛒 NEW SUBSCRIPTION' : '🔁 RENEWAL',
      `👤 ${esc(r.playerName)}${r.phone ? ` · 📱 ${r.phone}` : ''}`,
      `📦 ${esc(r.planLabel)} · ₹${r.amount}${r.credit > 0 ? ` (₹${r.price} − ₹${r.credit} credit)` : ''}`,
      keyLine,
      `🧾 UTR: ${utr || 'not given'}`,
      r.referralCode ? `🎁 Referred by: ${esc(r.referralCode)}` : null,
      r.amount > 0 ? `\nCheck ₹${r.amount} arrived in your bank app, then tap a button.` : '\nPaid fully with wallet credit.'
    ].filter(Boolean).join('\n');

    let sent;
    try { sent = await tg.sendProof({ buffer, mime, caption, reqId: r.id }); }
    catch (e) {
      console.error(e.message);
      return res.status(502).json({ error: 'Could not send your request for approval. Please try again.' });
    }

    r.status = 'pending'; r.proofAt = Date.now(); r.utr = utr || null;
    r.tgChat = sent.chat; r.tgMsg = sent.msg; r.tgCaption = caption; r.tgPhoto = !!buffer;
    if (reservedKey) {
      r.reservedKey = reservedKey;
      await kv.set(`tb:pendkey:${reservedKey}`, r.id, { ex: PENDKEY_TTL_S });
    }
    if (utr) await kv.set(`tb:utr:${utr}`, r.id, { ex: 90 * 86400 });
    await kv.set(REQ_KEY, list);

    return res.json({ ok: true, key: reservedKey || r.existingKey });
  }

  /* ── POST action=check: player polls for approval ── */
  if (action === 'check') {
    if (await rateLimit(req, 'purchcheck', 600, 3600))
      return res.status(429).json({ error: 'Too many requests' });
    const { reqId, token } = req.body;
    if (!reqId || !token) return res.status(400).json({ error: 'reqId and token required' });

    const r = findOwned(await kv.get(REQ_KEY) || [], reqId, token);
    if (!r) return res.status(404).json({ error: 'Request not found' });

    const age = Date.now() - r.createdAt;
    if ((r.status === 'draft' && age > DRAFT_TTL_MS) || (r.status === 'pending' && Date.now() - (r.proofAt || r.createdAt) > PENDING_TTL_MS))
      return res.json({ status: 'expired' });

    return res.json({
      status: r.status === 'draft' ? 'pending' : r.status,
      key: r.status === 'approved' ? r.resultKey : null,
      expiresAt: r.resultExpiresAt || null, plan: r.planLabel, reason: r.reason || null
    });
  }

  /* ── POST action=cancel: player backs out of a request that has no proof yet ── */
  if (action === 'cancel') {
    const { reqId, token } = req.body;
    if (!reqId || !token) return res.status(400).json({ error: 'reqId and token required' });
    const list = await kv.get(REQ_KEY) || [];
    const r = findOwned(list, reqId, token);
    if (r && r.status === 'draft') { r.status = 'cancelled'; r.resolvedAt = Date.now(); await kv.set(REQ_KEY, list); }
    return res.json({ ok: true });
  }

  /* ── admin web panel: approve / reject ── */
  if (action === 'approve' || action === 'reject') {
    if (await rateLimit(req, 'purchresolve', 60, 3600))
      return res.status(429).json({ error: 'Too many requests' });
    const { password, reqId } = req.body;
    if (!checkPassword(password, process.env.ADMIN_PASSWORD))
      return res.status(401).json({ error: 'Wrong password' });
    const out = await resolveRequest(reqId, action, req.body.reason, 'admin panel');
    return res.status(out.http).json(out.body);
  }

  return res.status(400).json({ error: 'Unknown action' });
};
