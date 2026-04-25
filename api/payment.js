const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const kv = Redis.fromEnv();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function genReqId() {
  return Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
}

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* GET: admin lists pending requests */
  if (req.method === 'GET') {
    if (await rateLimit(req, 'listreqs', 60, 60))
      return res.status(429).json({ error: 'Too many requests' });
    const { password } = req.query;
    if (!checkPassword(password, process.env.ADMIN_PASSWORD))
      return res.status(401).json({ error: 'Wrong password' });
    const list = await kv.get('tb:requests') || [];
    return res.json(list);
  }

  if (req.method !== 'POST') return res.status(405).end();

  const { action } = req.body || {};

  /* Player submits day pass request */
  if (action === 'request') {
    if (await rateLimit(req, 'dayreq', 10, 3600))
      return res.status(429).json({ error: 'Too many requests. Try again in an hour.' });
    const { playerName, sheetCount } = req.body;
    const name = String(playerName || 'Player').trim().slice(0, 50);
    const count = Math.max(1, Math.min(150, Number(sheetCount) || 1));
    const cfg = await kv.get('tb:config') || { pricePerSheet: 5 };
    const amount = (cfg.pricePerSheet || 5) * count;
    const reqId = genReqId();
    const request = { reqId, playerName: name, sheetCount: count, amount, status: 'pending', createdAt: Date.now() };
    await kv.set(`tb:req:${reqId}`, request, { ex: 7200 }); // 2h TTL
    const list = await kv.get('tb:requests') || [];
    list.unshift(request);
    await kv.set('tb:requests', list.slice(0, 100));
    return res.json({ ok: true, reqId, amount, playerName: name });
  }

  /* Player polls for approval status */
  if (action === 'check') {
    if (await rateLimit(req, 'checkreq', 120, 60))
      return res.status(429).json({ error: 'Too many requests' });
    const { reqId } = req.body;
    if (!reqId) return res.status(400).json({ error: 'reqId required' });
    const request = await kv.get(`tb:req:${reqId}`);
    if (!request) return res.status(404).json({ error: 'Request expired' });
    return res.json({
      status: request.status,
      code: request.status === 'approved' ? request.code : undefined,
      playerName: request.playerName,
      sheetCount: request.sheetCount
    });
  }

  /* Admin approves request → creates day pass code */
  if (action === 'approve') {
    if (await rateLimit(req, 'approvereq', 30, 3600))
      return res.status(429).json({ error: 'Too many requests' });
    const { password, reqId } = req.body;
    if (!checkPassword(password, process.env.ADMIN_PASSWORD))
      return res.status(401).json({ error: 'Wrong password' });
    if (!reqId) return res.status(400).json({ error: 'reqId required' });

    const request = await kv.get(`tb:req:${reqId}`);
    if (!request) return res.status(404).json({ error: 'Request not found or expired' });
    if (request.status !== 'pending') return res.status(409).json({ error: 'Already processed' });

    let code, tries = 0;
    do { code = genCode(); tries++; }
    while (await kv.exists(`tb:code:${code}`) && tries < 10);

    const session = {
      code, playerName: request.playerName, sheetCount: request.sheetCount,
      amount: request.amount, createdAt: Date.now(), status: 'active', type: 'daypass'
    };
    await kv.set(`tb:code:${code}`, session, { ex: 86400 });

    const sessions = await kv.get('tb:sessions') || [];
    sessions.unshift(session);
    await kv.set('tb:sessions', sessions.slice(0, 300));

    request.status = 'approved';
    request.code = code;
    request.approvedAt = Date.now();
    await kv.set(`tb:req:${reqId}`, request, { ex: 3600 });

    const list = await kv.get('tb:requests') || [];
    const idx = list.findIndex(r => r.reqId === reqId);
    if (idx >= 0) list[idx] = request;
    await kv.set('tb:requests', list);

    return res.json({ ok: true, code });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
