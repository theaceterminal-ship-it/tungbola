const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const kv = Redis.fromEnv();

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  if (await rateLimit(req, 'sessions', 120, 3600))
    return res.status(429).json({ error: 'Too many requests' });

  const { password } = req.query;
  if (!checkPassword(password, process.env.ADMIN_PASSWORD))
    return res.status(401).json({ error: 'Wrong password' });

  const raw = await kv.get('tb:sessions') || [];
  const fiveHours = 5 * 60 * 60 * 1000;
  const now = Date.now();

  // Drop ended sessions older than 5 hours
  const cleaned = raw.filter(s =>
    s.status !== 'ended' || (now - (s.endedAt || s.createdAt)) < fiveHours
  );

  // Only show last 5 active sessions + any recent ended ones that survived the cut
  const active = cleaned.filter(s => s.status !== 'ended').slice(0, 5);
  const recentEnded = cleaned.filter(s => s.status === 'ended');
  const list = [...active, ...recentEnded];

  // Persist cleaned list back if anything was removed
  if (cleaned.length < raw.length) {
    await kv.set('tb:sessions', cleaned.slice(0, 300));
  }

  res.json(list);
};
