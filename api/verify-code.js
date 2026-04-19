const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit } = require('./_security');
const kv = Redis.fromEnv();

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Strict rate limit: 8 attempts per IP per 15 minutes
  if (await rateLimit(req, 'verify', 8, 900))
    return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });

  const { code, deviceId } = req.body || {};
  if (!code || typeof code !== 'string')
    return res.status(400).json({ error: 'Code required' });

  const clean = code.toUpperCase().trim().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 6)
    return res.status(400).json({ error: 'Invalid code format' });

  const did = typeof deviceId === 'string' ? deviceId.slice(0, 64) : null;

  const session = await kv.get(`tb:code:${clean}`);

  if (!session)
    return res.status(404).json({ error: 'Code not found. Check with your host.' });
  if (session.status === 'ended')
    return res.status(410).json({ error: 'This session has already ended.' });

  // Device binding: first device to verify owns the code
  if (session.deviceId) {
    if (!did || session.deviceId !== did)
      return res.status(403).json({ error: 'This code is already activated on another device.' });
  } else if (did) {
    session.deviceId = did;
    await kv.set(`tb:code:${clean}`, session);
  }

  res.json({
    valid: true,
    playerName: session.playerName,
    sheetCount: session.sheetCount,
    amount: session.amount,
    createdAt: session.createdAt
  });
};
