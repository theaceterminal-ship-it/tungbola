/* ═══════════════════════════════════════════════════════════════════════════
   TUNGBOLA ANALYTICS — who is here now, who came today
   ───────────────────────────────────────────────────────────────────────────
   Deliberately small. Three Redis structures, no third-party tracker, no IPs
   stored, no cross-site anything. Everything keys off the device id the app
   already generates for subscription device limits.

     tb:live        sorted set   member = deviceId, score = last ping (ms)
                                 "online now" = scored within LIVE_WINDOW
     tb:devmeta     hash         deviceId -> {name, plan, state, sheets, since}
     tb:seen:<date> set          device ids seen that day, expires after 45d

   COST NOTE — Upstash bills per command, so the client registers fully once
   per day and then sends a 1-command heartbeat. A player with the tab open
   for a 2-hour game costs ~120 commands, not 120 x 3.
   ═══════════════════════════════════════════════════════════════════════════ */
const { Redis } = require('@upstash/redis');
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const kv = Redis.fromEnv();

const LIVE = 'tb:live';
const META = 'tb:devmeta';
const LIVE_WINDOW = 150 * 1000;        // a miss or two of the 60s heartbeat
const STALE = 30 * 60 * 1000;          // prune from the live set after this
const SEEN_TTL = 45 * 86400;           // keep ~6 weeks of daily history
const HISTORY_DAYS = 14;

function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
function clean(s, n) { return String(s == null ? '' : s).slice(0, n); }

module.exports = async function(req, res) {
  secureHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* ── POST: a player checks in ─────────────────────────────────────────── */
  if (req.method === 'POST') {
    // generous: this is a heartbeat, not a mutation
    if (await rateLimit(req, 'ping', 400, 3600)) return res.json({ ok: false });

    const { deviceId, state, playerName, plan, sheets, full } = req.body || {};
    if (!deviceId || typeof deviceId !== 'string') return res.status(400).json({ ok: false });
    const did = deviceId.replace(/[^\w-]/g, '').slice(0, 64);
    if (!did) return res.status(400).json({ ok: false });

    const now = Date.now();
    try {
      // heartbeat: one command, sent every 60s while the tab is open
      await kv.zadd(LIVE, { score: now, member: did });

      // full check-in: first load of the day, or when what they're doing changes
      if (full) {
        await Promise.all([
          kv.hset(META, {
            [did]: JSON.stringify({
              name: clean(playerName, 50),
              plan: clean(plan, 24),
              state: clean(state, 16) || 'idle',
              sheets: Math.max(0, Math.min(999, Number(sheets) || 0)),
              at: now
            })
          }),
          kv.sadd(`tb:seen:${dayKey(now)}`, did)
            .then(() => kv.expire(`tb:seen:${dayKey(now)}`, SEEN_TTL))
        ]);
      }
    } catch (e) { /* analytics must never break a game */ }
    return res.json({ ok: true });
  }

  if (req.method !== 'GET') return res.status(405).end();

  /* ── GET: admin dashboard ─────────────────────────────────────────────── */
  if (await rateLimit(req, 'analytics', 120, 3600))
    return res.status(429).json({ error: 'Too many requests' });
  const { password } = req.query;
  if (!checkPassword(password, process.env.ADMIN_PASSWORD))
    return res.status(401).json({ error: 'Wrong password' });

  const now = Date.now();
  try {
    // drop long-gone devices so the live set stays small
    await kv.zremrangebyscore(LIVE, 0, now - STALE);

    const liveIds = await kv.zrange(LIVE, now - LIVE_WINDOW, now, { byScore: true }) || [];
    const recentIds = await kv.zrange(LIVE, now - STALE, now, { byScore: true }) || [];
    const metaRaw = (recentIds.length ? await kv.hgetall(META) : {}) || {};

    const parse = v => {
      if (!v) return {};
      if (typeof v === 'object') return v;
      try { return JSON.parse(v); } catch (e) { return {}; }
    };

    const liveSet = new Set(liveIds);
    const people = recentIds.map(id => {
      const m = parse(metaRaw[id]);
      return {
        id: id.slice(0, 8),                 // enough to tell rows apart, not a fingerprint
        name: m.name || 'Guest',
        plan: m.plan || '',
        state: m.state || 'idle',
        sheets: m.sheets || 0,
        lastSeen: m.at || 0,
        online: liveSet.has(id)
      };
    }).sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen));

    // daily unique visitors, most recent first
    const days = [];
    for (let i = 0; i < HISTORY_DAYS; i++) days.push(dayKey(now - i * 86400000));
    const counts = await Promise.all(days.map(d => kv.scard(`tb:seen:${d}`).catch(() => 0)));
    const history = days.map((d, i) => ({ day: d, visitors: counts[i] || 0 }));

    // meta can outlive the live set; trim it when it drifts far ahead
    const metaKeys = Object.keys(metaRaw);
    if (metaKeys.length > recentIds.length + 200) {
      const keep = new Set(recentIds);
      const drop = metaKeys.filter(k => !keep.has(k));
      if (drop.length) await kv.hdel(META, ...drop.slice(0, 400)).catch(() => {});
    }

    return res.json({
      onlineNow: liveIds.length,
      playingNow: people.filter(p => p.online && p.state === 'playing').length,
      today: history[0] ? history[0].visitors : 0,
      yesterday: history[1] ? history[1].visitors : 0,
      history,
      people: people.slice(0, 100),
      serverTime: now
    });
  } catch (e) {
    return res.status(200).json({
      onlineNow: 0, playingNow: 0, today: 0, yesterday: 0,
      history: [], people: [], serverTime: now, error: 'analytics unavailable'
    });
  }
};
