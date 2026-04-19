const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit } = require('./_security');
const kv = Redis.fromEnv();

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  // 60 polls per IP per minute
  if (await rateLimit(req, 'checkreq', 60, 60))
    return res.status(429).json({ error: 'Too many requests' });

  const { id, deviceId } = req.query;
  if (!id || typeof id !== 'string')
    return res.status(400).json({ error: 'Request ID required' });

  const clean = id.toUpperCase().trim().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const request = await kv.get(`tb:req:${clean}`);

  if (!request) return res.status(404).json({ error: 'Request not found' });

  // Only return the code if the correct device is asking
  const did = typeof deviceId === 'string' ? deviceId.slice(0, 64) : null;
  const ownsRequest = did && request.deviceId === did;

  if (request.status === 'approved' && ownsRequest) {
    return res.json({ status: 'approved', code: request.code });
  }

  res.json({ status: request.status });
};
