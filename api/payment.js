/* Parse-error reporting only. Day-pass / pay-per-sheet payment requests were
   removed — every player now goes through a subscription key instead. */
const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const kv = Redis.fromEnv();

const KEY = 'tb:parse_errors';
const KEEP_DAYS = 30;          // anything older is dropped on read
const MAX_ENTRIES = 200;

/* Older entries were written without an id. Derive a stable one from the
   timestamp so the admin can delete individual reports either way. */
function withId(log, i) {
  return { ...log, id: log.id || `${log.reportedAt}-${i}` };
}

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

    const raw = await kv.get(KEY) || [];
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    const fresh = raw.filter(l => (l.reportedAt || 0) >= cutoff);
    if (fresh.length !== raw.length) await kv.set(KEY, fresh);
    return res.json({ parseErrors: fresh.map(withId) });
  }

  if (req.method !== 'POST') return res.status(405).end();
  const { action } = req.body || {};

  /* Player reports a parse error — logged for admin review */
  if (action === 'report') {
    if (await rateLimit(req, 'parsereport', 20, 3600))
      return res.status(429).json({ ok: false });
    const { errors } = req.body;
    if (!Array.isArray(errors) || !errors.length) return res.status(400).json({ ok: false });
    const log = await kv.get(KEY) || [];
    log.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      errors: errors.slice(0, 20),
      reportedAt: Date.now()
    });
    await kv.set(KEY, log.slice(0, MAX_ENTRIES));
    return res.json({ ok: true });
  }

  /* ── admin housekeeping ──────────────────────────────────────────────────
     These reports pile up fast: one bad sheet can log several tickets, and a
     host re-uploading the same file logs it again. Let the admin clear the
     whole list, wipe a single day, or drop one report.                     */
  if (action === 'clear-errors' || action === 'delete-error' || action === 'clear-errors-before') {
    if (await rateLimit(req, 'clearerrors', 60, 3600))
      return res.status(429).json({ error: 'Too many requests' });
    const { password } = req.body;
    if (!checkPassword(password, process.env.ADMIN_PASSWORD))
      return res.status(401).json({ error: 'Wrong password' });

    const log = (await kv.get(KEY) || []).map(withId);
    let kept;

    if (action === 'clear-errors') {
      const { day } = req.body;                       // 'YYYY-MM-DD', optional
      kept = day
        ? log.filter(l => new Date(l.reportedAt).toISOString().slice(0, 10) !== day)
        : [];
    } else if (action === 'clear-errors-before') {
      const before = Number(req.body.before) || 0;    // drop everything older
      kept = log.filter(l => (l.reportedAt || 0) >= before);
    } else {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'id required' });
      kept = log.filter(l => l.id !== id);
    }

    await kv.set(KEY, kept);
    return res.json({ ok: true, removed: log.length - kept.length, remaining: kept.length });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
