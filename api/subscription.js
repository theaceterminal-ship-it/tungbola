const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const kv = Redis.fromEnv();

function genSubKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `SUB-${part()}-${part()}-${part()}`;
}

/* Flexible duration: 1..36 months, calendar-accurate. Clamps the day-of-month
   so e.g. Jan 31 + 1 month lands on Feb 28, not overflows into March. */
function addMonths(fromMs, months) {
  const d = new Date(fromMs);
  const day = d.getDate();
  d.setDate(1);                       // avoid overflow while changing month
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d.getTime();
}
function planLabel(months) {
  if (!months || months < 1) return 'Custom';
  if (months % 12 === 0) return months === 12 ? '1 Year' : `${months / 12} Years`;
  return months === 1 ? '1 Month' : `${months} Months`;
}
/* Backward compatibility: subscriptions created before this update only have
   plan:'monthly'|'yearly' and no `months` field. */
function monthsOf(sub) {
  if (sub.months) return sub.months;
  return sub.plan === 'yearly' ? 12 : 1;
}

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── GET: list all subscriptions (admin) ── */
  if (req.method === 'GET') {
    if (await rateLimit(req, 'listsubs', 60, 60))
      return res.status(429).json({ error: 'Too many requests' });
    const { password } = req.query;
    if (!checkPassword(password, process.env.ADMIN_PASSWORD))
      return res.status(401).json({ error: 'Wrong password' });
    const list = await kv.get('tb:subscriptions') || [];
    // normalize so the admin UI always has `months` + a human label to show
    const out = list.map(s => ({ ...s, months: monthsOf(s), planLabel: planLabel(monthsOf(s)) }));
    return res.json(out);
  }

  if (req.method !== 'POST') return res.status(405).end();

  const { action } = req.body || {};

  /* ── POST action=verify: player verifies subscription key ── */
  if (action === 'verify') {
    if (await rateLimit(req, 'verifysub', 20, 900))
      return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });

    const { key, deviceId } = req.body;
    if (!key || typeof key !== 'string')
      return res.status(400).json({ error: 'Subscription key required' });

    const clean = key.toUpperCase().trim().replace(/[^A-Z0-9-]/g, '');
    const did = typeof deviceId === 'string' ? deviceId.slice(0, 64) : null;
    const sub = await kv.get(`tb:sub:${clean}`);

    if (!sub) return res.status(404).json({ error: 'Subscription key not found. Check with your host.' });
    if (sub.status === 'revoked') return res.status(410).json({ error: 'This subscription has been cancelled.' });
    if (Date.now() > sub.expiresAt) return res.status(410).json({ error: 'Subscription expired. Please renew.' });

    if (did && !sub.devices.includes(did)) {
      if (sub.devices.length >= sub.maxDevices)
        return res.status(403).json({ error: `Device limit reached (${sub.maxDevices} devices max). Contact admin to reset devices.` });
      sub.devices.push(did);
      await kv.set(`tb:sub:${clean}`, sub);
      const list = await kv.get('tb:subscriptions') || [];
      const idx = list.findIndex(s => s.key === clean);
      if (idx >= 0) list[idx] = sub;
      await kv.set('tb:subscriptions', list);
    }

    const daysLeft = Math.ceil((sub.expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
    const months = monthsOf(sub);
    return res.json({
      valid: true, playerName: sub.playerName,
      months, plan: planLabel(months),           // `plan` kept as a ready-to-show label
      expiresAt: sub.expiresAt, daysLeft,
      devicesUsed: sub.devices.length, maxDevices: sub.maxDevices,
      renewalDue: daysLeft <= 2                   // player app can show a polite reminder banner
    });
  }

  /* ── POST action=create: admin creates a subscription ── */
  if (action === 'create') {
    if (await rateLimit(req, 'createsub', 20, 3600))
      return res.status(429).json({ error: 'Too many requests' });

    const { password, playerName, months, maxDevices, phone } = req.body;
    if (!checkPassword(password, process.env.ADMIN_PASSWORD))
      return res.status(401).json({ error: 'Wrong password' });

    const name = String(playerName || 'Player').trim().slice(0, 50);
    const dur = Math.max(1, Math.min(36, parseInt(months) || 1));
    const devices = Math.max(1, Math.min(5, Number(maxDevices) || 3));
    const cleanPhone = String(phone || '').replace(/\D/g, '').slice(0, 15);
    const expiresAt = addMonths(Date.now(), dur);

    let key, tries = 0;
    do { key = genSubKey(); tries++; }
    while (await kv.exists(`tb:sub:${key}`) && tries < 10);

    const subscription = {
      key, playerName: name, months: dur, phone: cleanPhone,
      maxDevices: devices, devices: [], status: 'active', createdAt: Date.now(), expiresAt
    };

    const ttlSeconds = Math.ceil((expiresAt - Date.now()) / 1000) + 86400;
    await kv.set(`tb:sub:${key}`, subscription, { ex: ttlSeconds });
    const list = await kv.get('tb:subscriptions') || [];
    list.unshift(subscription);
    await kv.set('tb:subscriptions', list.slice(0, 500));

    return res.json({ ok: true, key, playerName: name, months: dur, plan: planLabel(dur), expiresAt, maxDevices: devices });
  }

  /* ── POST action=end: admin revokes a subscription ── */
  /* ── POST action=reset-devices: admin clears device slots ── */
  /* ── POST action=update: admin edits phone / extends duration ── */
  if (action === 'end' || action === 'reset-devices' || action === 'update') {
    if (await rateLimit(req, 'endsub', 20, 3600))
      return res.status(429).json({ error: 'Too many requests' });

    const { password, key } = req.body;
    if (!checkPassword(password, process.env.ADMIN_PASSWORD))
      return res.status(401).json({ error: 'Wrong password' });
    if (!key) return res.status(400).json({ error: 'Key required' });

    const clean = key.toUpperCase().trim().replace(/[^A-Z0-9-]/g, '');
    const sub = await kv.get(`tb:sub:${clean}`);
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });

    if (action === 'reset-devices') {
      sub.devices = [];
      await kv.set(`tb:sub:${clean}`, sub);
      const list = await kv.get('tb:subscriptions') || [];
      const idx = list.findIndex(s => s.key === clean);
      if (idx >= 0) list[idx] = sub;
      await kv.set('tb:subscriptions', list);
      return res.json({ ok: true, action: 'devices_reset' });
    }

    if (action === 'update') {
      const { phone, extendMonths } = req.body;
      if (typeof phone === 'string') sub.phone = phone.replace(/\D/g, '').slice(0, 15);

      /* extendMonths moves the end date either way: positive adds time,
         negative takes it back (a wrong duration entered at creation, a
         partial refund, a downgrade). Shortening can legitimately land in the
         past — that simply expires the key, which the admin sees straight
         away — but it must never run past 36 months in either direction. */
      const delta = parseInt(extendMonths, 10);
      if (delta) {
        const move = Math.max(-36, Math.min(36, delta));
        sub.months = Math.max(0, monthsOf(sub) + move);
        sub.expiresAt = addMonths(sub.expiresAt, move);
        if (move > 0 && sub.status === 'revoked') sub.status = 'active';
      }

      await kv.set(`tb:sub:${clean}`, sub);
      const list = await kv.get('tb:subscriptions') || [];
      const idx = list.findIndex(s => s.key === clean);
      if (idx >= 0) list[idx] = sub;
      await kv.set('tb:subscriptions', list);
      return res.json({
        ok: true, action: 'updated',
        expiresAt: sub.expiresAt, months: monthsOf(sub),
        planLabel: planLabel(monthsOf(sub)),
        expired: Date.now() > sub.expiresAt
      });
    }

    sub.status = 'revoked';
    sub.revokedAt = Date.now();
    await kv.set(`tb:sub:${clean}`, sub);
    const list = await kv.get('tb:subscriptions') || [];
    const idx = list.findIndex(s => s.key === clean);
    if (idx >= 0) { list[idx].status = 'revoked'; list[idx].revokedAt = Date.now(); }
    await kv.set('tb:subscriptions', list);
    return res.json({ ok: true, action: 'revoked' });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
