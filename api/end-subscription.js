const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const kv = Redis.fromEnv();

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  if (await rateLimit(req, 'endsub', 20, 3600))
    return res.status(429).json({ error: 'Too many requests' });

  const { password, key, resetDevices } = req.body || {};
  if (!checkPassword(password, process.env.ADMIN_PASSWORD))
    return res.status(401).json({ error: 'Wrong password' });

  if (!key) return res.status(400).json({ error: 'Key required' });

  const clean = key.toUpperCase().trim().replace(/[^A-Z0-9-]/g, '');
  const sub = await kv.get(`tb:sub:${clean}`);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });

  if (resetDevices) {
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

  res.json({ ok: true, action: 'revoked' });
};
