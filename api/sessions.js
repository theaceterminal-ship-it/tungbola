const { Redis } = require('@upstash/redis');
const kv = Redis.fromEnv();

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const { password } = req.query;
  if (password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' });

  const list = await kv.get('tb:sessions') || [];
  res.json(list);
};
