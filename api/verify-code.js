const { Redis } = require('@upstash/redis');
const kv = Redis.fromEnv();

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required' });

  const session = await kv.get(`tb:code:${code.toUpperCase().trim()}`);

  if (!session)
    return res.status(404).json({ error: 'Code not found. Check with your host.' });
  if (session.status === 'ended')
    return res.status(410).json({ error: 'This session has already ended.' });

  res.json({
    valid: true,
    playerName: session.playerName,
    sheetCount: session.sheetCount,
    amount: session.amount,
    createdAt: session.createdAt
  });
};
