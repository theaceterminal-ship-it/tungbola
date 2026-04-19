const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const kv = Redis.fromEnv();

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  if (await rateLimit(req, 'sessions', 30, 3600))
    return res.status(429).json({ error: 'Too many requests' });

  const { password } = req.query;
  if (!checkPassword(password, process.env.ADMIN_PASSWORD))
    return res.status(401).json({ error: 'Wrong password' });

  const list = await kv.get('tb:sessions') || [];
  res.json(list);
};
