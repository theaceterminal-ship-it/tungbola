/* Parse-error reporting only. Day-pass / pay-per-sheet payment requests were
   removed — every player now goes through a subscription key instead. */
const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const kv = Redis.fromEnv();

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* GET: admin fetches logged PDF/JPG parse errors */
  if (req.method === 'GET') {
    if (await rateLimit(req, 'listreqs', 60, 60))
      return res.status(429).json({ error: 'Too many requests' });
    const { password } = req.query;
    if (!checkPassword(password, process.env.ADMIN_PASSWORD))
      return res.status(401).json({ error: 'Wrong password' });
    const parseErrors = await kv.get('tb:parse_errors') || [];
    return res.json({ parseErrors });
  }

  if (req.method !== 'POST') return res.status(405).end();
  const { action } = req.body || {};

  /* Player reports a parse error — logged for admin review */
  if (action === 'report') {
    if (await rateLimit(req, 'parsereport', 20, 3600))
      return res.status(429).json({ ok: false });
    const { errors } = req.body;
    if (!Array.isArray(errors) || !errors.length) return res.status(400).json({ ok: false });
    const log = await kv.get('tb:parse_errors') || [];
    log.unshift({ errors: errors.slice(0, 20), reportedAt: Date.now() });
    await kv.set('tb:parse_errors', log.slice(0, 200));
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
