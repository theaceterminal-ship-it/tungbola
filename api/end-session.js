const { kv } = require('@vercel/kv');

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { code, password } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required' });

  if (password && password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' });

  const key = `tb:code:${code.toUpperCase().trim()}`;
  const session = await kv.get(key);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.status = 'ended';
  session.endedAt = Date.now();
  await kv.set(key, session);

  const list = await kv.get('tb:sessions') || [];
  const idx = list.findIndex(s => s.code === code.toUpperCase().trim());
  if (idx >= 0) { list[idx].status = 'ended'; list[idx].endedAt = Date.now(); }
  await kv.set('tb:sessions', list);

  res.json({ ok: true });
};
