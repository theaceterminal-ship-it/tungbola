const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const kv = Redis.fromEnv();

/* ── Get real client IP ── */
function getIP(req) {
  return ((req.headers['x-forwarded-for'] || '').split(',')[0]).trim()
    || req.headers['x-real-ip']
    || 'unknown';
}

/* ── Constant-time password comparison (prevents timing attacks) ── */
function checkPassword(input, expected) {
  if (!input || !expected) return false;
  try {
    const h = k => crypto.createHmac('sha256', 'tb-cmp-key').update(String(k)).digest();
    return crypto.timingSafeEqual(h(input), h(expected));
  } catch(e) { return false; }
}

/* ── Redis-backed rate limiter ── */
async function rateLimit(req, action, max, windowSecs) {
  try {
    const ip = getIP(req);
    const key = `tb:rl:${action}:${ip}`;
    const count = await kv.incr(key);
    if (count === 1) await kv.expire(key, windowSecs);
    return count > max;
  } catch(e) {
    return false; // fail open if Redis is unavailable
  }
}

/* ── Security + CORS headers on every response ── */
function secureHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');
}

module.exports = { getIP, checkPassword, rateLimit, secureHeaders };
