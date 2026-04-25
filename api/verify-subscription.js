const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit } = require('./_security');
const kv = Redis.fromEnv();

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  if (await rateLimit(req, 'verifysub', 20, 900))
    return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });

  const { key, deviceId } = req.body || {};
  if (!key || typeof key !== 'string')
    return res.status(400).json({ error: 'Subscription key required' });

  const clean = key.toUpperCase().trim().replace(/[^A-Z0-9-]/g, '');
  const did = typeof deviceId === 'string' ? deviceId.slice(0, 64) : null;

  const sub = await kv.get(`tb:sub:${clean}`);

  if (!sub) return res.status(404).json({ error: 'Subscription key not found. Check with your host.' });
  if (sub.status === 'revoked') return res.status(410).json({ error: 'This subscription has been cancelled.' });
  if (Date.now() > sub.expiresAt) return res.status(410).json({ error: 'Subscription expired. Please renew.' });

  if (did) {
    if (!sub.devices.includes(did)) {
      if (sub.devices.length >= sub.maxDevices) {
        return res.status(403).json({
          error: `Device limit reached (${sub.maxDevices} devices max). Contact admin to reset devices.`
        });
      }
      sub.devices.push(did);
      await kv.set(`tb:sub:${clean}`, sub);

      const list = await kv.get('tb:subscriptions') || [];
      const idx = list.findIndex(s => s.key === clean);
      if (idx >= 0) list[idx] = sub;
      await kv.set('tb:subscriptions', list);
    }
  }

  const daysLeft = Math.ceil((sub.expiresAt - Date.now()) / (24 * 60 * 60 * 1000));

  res.json({
    valid: true,
    playerName: sub.playerName,
    plan: sub.plan,
    expiresAt: sub.expiresAt,
    daysLeft,
    devicesUsed: sub.devices.length,
    maxDevices: sub.maxDevices
  });
};
