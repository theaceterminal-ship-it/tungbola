const { kv } = require('@vercel/kv');

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { password, pricePerSheet, upiId, whatsappNumber } = req.body || {};
  if (password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' });

  await kv.set('tb:config', {
    pricePerSheet: Math.max(1, Number(pricePerSheet) || 5),
    upiId: String(upiId || '').trim(),
    whatsappNumber: String(whatsappNumber || '').replace(/\D/g, '')
  });
  res.json({ ok: true });
};
