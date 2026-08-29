/* Parse-error reporting. Day-pass / pay-per-sheet payment requests were
   removed — every player now goes through a subscription key instead.

   Alongside the ticket-level summary (which numbers were found, what was
   missing), a report can carry the actual PDF/JPG that failed to parse,
   stored in Vercel Blob exactly like the marketplace sheet uploads in
   sheets.js. A real failing file is worth far more than a description of
   it — it's a ready-made test case for strengthening the parser — so it's
   kept alongside the text summary rather than instead of it. */
const { Redis } = require('@upstash/redis');
const { put, del: blobDel } = require('@vercel/blob');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const kv = Redis.fromEnv();

const KEY = 'tb:parse_errors';
const KEEP_DAYS = 30;          // anything older is dropped on read
const MAX_ENTRIES = 200;
const MAX_FILE_BYTES = 6 * 1024 * 1024;   // skip attaching anything bigger; text summary still saved

/* Older entries were written without an id. Derive a stable one from the
   timestamp so the admin can delete individual reports either way. */
function withId(log, i) {
  return { ...log, id: log.id || `${log.reportedAt}-${i}` };
}

async function deleteAttachedBlobs(logs) {
  await Promise.all(logs.filter(l => l.fileUrl).map(l => blobDel(l.fileUrl).catch(() => {})));
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
    if (fresh.length !== raw.length) {
      await kv.set(KEY, fresh);
      deleteAttachedBlobs(raw.filter(l => (l.reportedAt || 0) < cutoff)).catch(() => {});
    }
    return res.json({ parseErrors: fresh.map(withId) });
  }

  if (req.method !== 'POST') return res.status(405).end();
  const { action } = req.body || {};

  /* Player reports a parse error — logged for admin review. `file` is
     optional: {name, data (base64), method}. Uploading it is best-effort —
     a failed or oversized upload still saves the text summary, since that
     was the entire behaviour before this existed. */
  if (action === 'report') {
    // One report per FAILING FILE now, not one per batch — a single large
    // upload with a lot of trouble in it can legitimately fire many of
    // these in a row, so this needs real headroom, not a login-style limit.
    if (await rateLimit(req, 'parsereport', 60, 3600))
      return res.status(429).json({ ok: false });
    const { errors, file } = req.body;
    if (!Array.isArray(errors) || !errors.length) return res.status(400).json({ ok: false });

    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      errors: errors.slice(0, 20),
      reportedAt: Date.now()
    };

    if (file && file.data && file.name) {
      try {
        const buffer = Buffer.from(file.data, 'base64');
        if (buffer.length && buffer.length <= MAX_FILE_BYTES) {
          const safeName = String(file.name).replace(/[^\w.\-]/g, '_').slice(0, 80) || 'sheet';
          const blobName = `tungbola/failed/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
          const blob = await put(blobName, buffer, { access: 'public' });
          entry.fileUrl = blob.url;
          entry.fileName = safeName;
          entry.fileSize = buffer.length;
          entry.method = String(file.method || '').slice(0, 20);
        }
      } catch (e) {
        console.error('Failed-sheet blob upload error:', e);   // report still saves without it
      }
    }

    const log = await kv.get(KEY) || [];
    log.unshift(entry);
    const kept = log.slice(0, MAX_ENTRIES);
    if (log.length > MAX_ENTRIES) deleteAttachedBlobs(log.slice(MAX_ENTRIES)).catch(() => {});
    await kv.set(KEY, kept);
    return res.json({ ok: true, fileSaved: !!entry.fileUrl });
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
    const removedIds = new Set(kept.map(l => l.id));
    deleteAttachedBlobs(log.filter(l => !removedIds.has(l.id))).catch(() => {});
    return res.json({ ok: true, removed: log.length - kept.length, remaining: kept.length });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
