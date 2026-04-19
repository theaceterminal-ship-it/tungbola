const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const kv = Redis.fromEnv();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Rate limit: 30 per IP per hour
  if (await rateLimit(req, 'create', 30, 3600))
    return res.status(429).json({ error: 'Too many requests' });

  const { password, playerName, sheetCount } = req.body || {};

  if (!checkPassword(password, process.env.ADMIN_PASSWORD))
    return res.status(401).json({ error: 'Wrong password' });

  const name = String(playerName || 'Player').trim().slice(0, 50);
  const count = Math.max(1, Math.min(100, Number(sheetCount) || 1));

  const cfg = await kv.get('tb:config') || { pricePerSheet: 5 };
  const amount = (cfg.pricePerSheet || 5) * count;

  let code, tries = 0;
  do { code = genCode(); tries++; }
  while (await kv.exists(`tb:code:${code}`) && tries < 10);

  const session = { code, playerName: name, sheetCount: count, amount, createdAt: Date.now(), status: 'active' };
  await kv.set(`tb:code:${code}`, session);

  const list = await kv.get('tb:sessions') || [];
  list.unshift(session);
  await kv.set('tb:sessions', list.slice(0, 300));

  res.json({ ok: true, code, amount, playerName: name, sheetCount: count });
};
