/* Shared subscription helpers — used by api/subscription.js (admin-managed
   subscriptions) and api/purchase.js (self-serve purchase/renewal
   requests) so both share the exact same calendar math and labelling
   instead of two copies quietly drifting apart. */

function genSubKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `SUB-${part()}-${part()}-${part()}`;
}

/* A short, sayable code a subscriber can share to refer someone else —
   first name + a few random characters, e.g. "PRIYA47". Callers retry on
   collision the same way genSubKey's callers do. */
function genReferralCode(playerName) {
  const base = String(playerName || 'PLAYER').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8) || 'PLAYER';
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const suffix = Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return base + suffix;
}

/* Flexible duration: 1..36 months, calendar-accurate. Clamps the day-of-month
   so e.g. Jan 31 + 1 month lands on Feb 28, not overflows into March. */
function addMonths(fromMs, months) {
  const d = new Date(fromMs);
  const day = d.getDate();
  d.setDate(1);                       // avoid overflow while changing month
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d.getTime();
}
function planLabel(months) {
  if (!months || months < 1) return 'Custom';
  if (months % 12 === 0) return months === 12 ? '1 Year' : `${months / 12} Years`;
  return months === 1 ? '1 Month' : `${months} Months`;
}
/* Backward compatibility: subscriptions created before this update only have
   plan:'monthly'|'yearly' and no `months` field. */
function monthsOf(sub) {
  if (sub.days) return 0;             // a day-based duration isn't a month count
  if (sub.months) return sub.months;
  return sub.plan === 'yearly' ? 12 : 1;
}
/* The label shown everywhere (admin list, key card, player status bar).
   A short day-based plan (currently just "1 Week") keeps its own wording
   instead of being forced into a fractional month.                        */
function subLabel(sub) {
  if (sub.days) return sub.days === 7 ? '1 Week' : `${sub.days} Day${sub.days === 1 ? '' : 's'}`;
  return planLabel(monthsOf(sub));
}

/* Move a subscription's expiry by a plan's duration, whichever shape it is. */
function advanceExpiry(fromMs, plan) {
  return plan.days ? fromMs + plan.days * 86400000 : addMonths(fromMs, plan.months || 1);
}

/* genSubKey / genReferralCode / purchase request ids all need "try a random
   value, retry on collision" against Redis — one place for that shape. */
async function pickUnique(kv, keyPrefix, genFn, tries = 10) {
  let value;
  for (let i = 0; i < tries; i++) {
    value = genFn();
    if (!(await kv.exists(`${keyPrefix}${value}`))) return value;
  }
  return value;   // exhausted retries: astronomically unlikely, take the last one
}

module.exports = { genSubKey, genReferralCode, addMonths, planLabel, monthsOf, subLabel, advanceExpiry, pickUnique };
