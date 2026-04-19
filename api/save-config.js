const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const kv = Redis.fromEnv();

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  if (await rateLimit(req, 'saveconfig', 20, 3600))
    return res.status(429).json({ error: 'Too many requests' });

  const { password, pricePerSheet, upiId, whatsappNumber } = req.body || {};

  if (!checkPassword(password, process.env.ADMIN_PASSWORD))
    return res.status(401).json({ error: 'Wrong password' });

  await kv.set('tb:config', {
    pricePerSheet: Math.max(1, Math.min(10000, Number(pricePerSheet) || 5)),
    upiId: String(upiId || '').trim().slice(0, 100),
    whatsappNumber: String(whatsappNumber || '').replace(/\D/g, '').slice(0, 15)
  });

  res.json({ ok: true });
};
