const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const kv = Redis.fromEnv();

function genSubKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `SUB-${part()}-${part()}-${part()}`;
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
    return res.json(list);
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
    return res.json({ valid: true, playerName: sub.playerName, plan: sub.plan,
      expiresAt: sub.expiresAt, daysLeft, devicesUsed: sub.devices.length, maxDevices: sub.maxDevices });
  }

  /* ── POST action=create: admin creates a subscription ── */
  if (action === 'create') {
    if (await rateLimit(req, 'createsub', 20, 3600))
      return res.status(429).json({ error: 'Too many requests' });

    const { password, playerName, plan, maxDevices } = req.body;
    if (!checkPassword(password, process.env.ADMIN_PASSWORD))
      return res.status(401).json({ error: 'Wrong password' });

    const name = String(playerName || 'Player').trim().slice(0, 50);
    const validPlan = plan === 'yearly' ? 'yearly' : 'monthly';
    const devices = Math.max(1, Math.min(5, Number(maxDevices) || 3));
    const days = validPlan === 'yearly' ? 365 : 30;
    const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;

    let key, tries = 0;
    do { key = genSubKey(); tries++; }
    while (await kv.exists(`tb:sub:${key}`) && tries < 10);

    const subscription = { key, playerName: name, plan: validPlan,
      maxDevices: devices, devices: [], status: 'active', createdAt: Date.now(), expiresAt };

    await kv.set(`tb:sub:${key}`, subscription, { ex: days * 24 * 3600 + 86400 });
    const list = await kv.get('tb:subscriptions') || [];
    list.unshift(subscription);
    await kv.set('tb:subscriptions', list.slice(0, 500));

    return res.json({ ok: true, key, playerName: name, plan: validPlan, expiresAt, maxDevices: devices, days });
  }

  /* ── POST action=end: admin revokes a subscription ── */
  /* ── POST action=reset-devices: admin clears device slots ── */
  if (action === 'end' || action === 'reset-devices') {
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
