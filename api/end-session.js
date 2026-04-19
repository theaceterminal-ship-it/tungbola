const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const kv = Redis.fromEnv();

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  if (await rateLimit(req, 'endsession', 20, 3600))
    return res.status(429).json({ error: 'Too many requests' });

  const { code, password } = req.body || {};
  if (!code || typeof code !== 'string')
    return res.status(400).json({ error: 'Code required' });

  // If password provided it must be correct (admin ending any session)
  // If no password it's a player ending their own session — allowed
  if (password && !checkPassword(password, process.env.ADMIN_PASSWORD))
    return res.status(401).json({ error: 'Wrong password' });

  const clean = code.toUpperCase().trim();
  const key = `tb:code:${clean}`;
  const session = await kv.get(key);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.status = 'ended';
  session.endedAt = Date.now();
  await kv.set(key, session);

  const list = await kv.get('tb:sessions') || [];
  const idx = list.findIndex(s => s.code === clean);
  if (idx >= 0) { list[idx].status = 'ended'; list[idx].endedAt = Date.now(); }
  await kv.set('tb:sessions', list);

  res.json({ ok: true });
};
