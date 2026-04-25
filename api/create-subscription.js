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
  if (req.method !== 'POST') return res.status(405).end();

  if (await rateLimit(req, 'createsub', 20, 3600))
    return res.status(429).json({ error: 'Too many requests' });

  const { password, playerName, plan, maxDevices } = req.body || {};

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

  const subscription = {
    key, playerName: name, plan: validPlan,
    maxDevices: devices, devices: [],
    status: 'active', createdAt: Date.now(), expiresAt
  };

  await kv.set(`tb:sub:${key}`, subscription, { ex: days * 24 * 3600 + 86400 });

  const list = await kv.get('tb:subscriptions') || [];
  list.unshift(subscription);
  await kv.set('tb:subscriptions', list.slice(0, 500));

  res.json({ ok: true, key, playerName: name, plan: validPlan, expiresAt, maxDevices: devices, days });
};
