const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit } = require('./_security');
const kv = Redis.fromEnv();

/* Shown to a player before the admin has ever configured pricing —
   keeps the "Buy or renew" screen from ever coming up empty. Once the
   admin saves their own tiers in Settings, tb:config.pricingTiers takes
   over and these are never seen again. */
const DEFAULT_TIERS = [
  { id: 'tier-1dev', label: '1 Device', months: 1, maxDevices: 1, price: 499 },
  { id: 'tier-2dev', label: '2 Devices', months: 1, maxDevices: 2, price: 999 },
  { id: 'tier-3dev', label: '3 Devices', months: 1, maxDevices: 3, price: 1499 }
];

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  if (await rateLimit(req, 'config', 60, 60)) // 60/min is plenty
    return res.status(429).json({ error: 'Too many requests' });

  try {
    const cfg = await kv.get('tb:config') || {};
    res.json({
      upiId: cfg.upiId || '',
      whatsappNumber: cfg.whatsappNumber || '',
      pricingTiers: Array.isArray(cfg.pricingTiers) && cfg.pricingTiers.length ? cfg.pricingTiers : DEFAULT_TIERS
    });
  } catch(e) {
    res.json({ upiId: '', whatsappNumber: '', pricingTiers: DEFAULT_TIERS });
  }
};
