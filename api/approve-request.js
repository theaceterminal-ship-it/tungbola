const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const kv = Redis.fromEnv();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  if (await rateLimit(req, 'approve', 30, 3600))
    return res.status(429).json({ error: 'Too many requests' });

  const { password, reqId } = req.body || {};
  if (!checkPassword(password, process.env.ADMIN_PASSWORD))
    return res.status(401).json({ error: 'Wrong password' });

  if (!reqId || typeof reqId !== 'string')
    return res.status(400).json({ error: 'Request ID required' });

  const clean = reqId.toUpperCase().trim().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const request = await kv.get(`tb:req:${clean}`);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'Request already processed' });

  // Generate unique code bound to this device
  let code, tries = 0;
  do { code = genCode(); tries++; }
  while (await kv.exists(`tb:code:${code}`) && tries < 10);

  const session = {
    code,
    playerName: request.playerName,
    sheetCount: request.sheetCount,
    amount: request.amount,
    deviceId: request.deviceId,  // bind code to requester's device
    createdAt: Date.now(),
    status: 'active',
    reqId: clean
  };

  await kv.set(`tb:code:${code}`, session);

  // Mark request as approved
  request.status = 'approved';
  request.code = code;
  request.approvedAt = Date.now();
  await kv.set(`tb:req:${clean}`, request, { ex: 86400 });

  // Update requests list
  const reqList = await kv.get('tb:requests') || [];
  const ri = reqList.findIndex(r => r.reqId === clean);
  if (ri >= 0) { reqList[ri].status = 'approved'; reqList[ri].code = code; }
  await kv.set('tb:requests', reqList);

  // Add to sessions list
  const sesList = await kv.get('tb:sessions') || [];
  sesList.unshift(session);
  await kv.set('tb:sessions', sesList.slice(0, 300));

  res.json({ ok: true, code, amount: session.amount, playerName: session.playerName });
};
