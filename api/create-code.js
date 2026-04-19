const { Redis } = require('@upstash/redis');
const kv = Redis.fromEnv();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { password, playerName, sheetCount } = req.body || {};
  if (password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' });

  const cfg = await kv.get('tb:config') || { pricePerSheet: 5 };
  const count = Math.max(1, Number(sheetCount) || 1);
  const amount = cfg.pricePerSheet * count;

  let code, tries = 0;
  do {
    code = genCode();
    tries++;
  } while (await kv.exists(`tb:code:${code}`) && tries < 10);

  const session = {
    code,
    playerName: String(playerName || 'Player').trim(),
    sheetCount: count,
    amount,
    createdAt: Date.now(),
    status: 'active'
  };

  await kv.set(`tb:code:${code}`, session);

  const list = await kv.get('tb:sessions') || [];
  list.unshift(session);
  await kv.set('tb:sessions', list.slice(0, 300));

  res.json({ ok: true, code, amount, playerName: session.playerName, sheetCount: count });
};
