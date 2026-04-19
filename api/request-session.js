const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit } = require('./_security');
const kv = Redis.fromEnv();

function genReqId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // 5 requests per IP per hour
  if (await rateLimit(req, 'reqsession', 5, 3600))
    return res.status(429).json({ error: 'Too many requests. Try again later.' });

  const { playerName, sheetCount, deviceId } = req.body || {};
  if (!playerName || typeof playerName !== 'string')
    return res.status(400).json({ error: 'Player name required' });
  if (!deviceId || typeof deviceId !== 'string')
    return res.status(400).json({ error: 'Device ID required' });

  const name = playerName.trim().slice(0, 50);
  const count = Math.max(1, Math.min(100, Number(sheetCount) || 1));
  const did = deviceId.slice(0, 64);

  const cfg = await kv.get('tb:config') || { pricePerSheet: 5 };
  const amount = (cfg.pricePerSheet || 5) * count;

  const reqId = genReqId();
  const request = {
    reqId, playerName: name, sheetCount: count, amount,
    deviceId: did, status: 'pending', createdAt: Date.now()
  };

  await kv.set(`tb:req:${reqId}`, request, { ex: 86400 }); // expires in 24h

  const list = await kv.get('tb:requests') || [];
  list.unshift(request);
  await kv.set('tb:requests', list.slice(0, 200));

  res.json({ ok: true, reqId, amount });
};
