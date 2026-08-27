const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const kv = Redis.fromEnv();

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  if (await rateLimit(req, 'saveconfig', 20, 3600))
    return res.status(429).json({ error: 'Too many requests' });

  const { password, upiId, whatsappNumber, pricingTiers } = req.body || {};

  if (!checkPassword(password, process.env.ADMIN_PASSWORD))
    return res.status(401).json({ error: 'Wrong password' });

  const prev = await kv.get('tb:config') || {};

  const cfg = {
    upiId: String(upiId || '').trim().slice(0, 100),
    whatsappNumber: String(whatsappNumber || '').replace(/\D/g, '').slice(0, 15),
    // omitted entirely -> keep whatever was there; sent -> replace (lets the
    // Settings form save UPI/WhatsApp and pricing independently if it wants to)
    pricingTiers: Array.isArray(pricingTiers) ? sanitizeTiers(pricingTiers) : (prev.pricingTiers || [])
  };

  await kv.set('tb:config', cfg);
  res.json({ ok: true });
};

function sanitizeTiers(tiers) {
  return tiers.slice(0, 12).map((t, i) => ({
    id: String(t.id || `tier-${Date.now()}-${i}`).slice(0, 40),
    label: String(t.label || '').trim().slice(0, 40) || `Plan ${i + 1}`,
    months: Math.max(1, Math.min(36, parseInt(t.months) || 1)),
    maxDevices: Math.max(1, Math.min(5, parseInt(t.maxDevices) || 1)),
    price: Math.max(0, Math.min(100000, Math.round(Number(t.price) || 0)))
  })).filter(t => t.price > 0);
}
