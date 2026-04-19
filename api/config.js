const { kv } = require('@vercel/kv');

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const cfg = await kv.get('tb:config') || { pricePerSheet: 5, upiId: '', whatsappNumber: '' };
    res.json(cfg);
  } catch(e) {
    res.json({ pricePerSheet: 5, upiId: '', whatsappNumber: '' });
  }
};
