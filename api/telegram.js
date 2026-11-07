/* Telegram webhook: the admin's Approve / Reject buttons land here.

   Security: Telegram echoes TELEGRAM_WEBHOOK_SECRET in a header on every call
   (set when the webhook is registered), AND the person pressing the button
   must be TELEGRAM_ADMIN_ID. Anything else is ignored.

   One-time setup helpers (no deploy of extra scripts needed):
     • GET /api/telegram?setup=1&password=<ADMIN_PASSWORD>  → registers this URL as the bot's webhook
     • message /start to the bot → it replies with your numeric Telegram id          */
const { secureHeaders, rateLimit, checkPassword } = require('./_security');
const tg = require('./_telegram');
const { resolveRequest } = require('./_purchase-core');

module.exports = async function(req, res) {
  secureHeaders(res);

  /* ── GET ?setup=1: register the webhook (admin password required) ── */
  if (req.method === 'GET') {
    if (await rateLimit(req, 'tgsetup', 10, 3600)) return res.status(429).json({ error: 'Too many requests' });
    if (!checkPassword(req.query.password, process.env.ADMIN_PASSWORD))
      return res.status(401).json({ error: 'Wrong password' });
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_WEBHOOK_SECRET)
      return res.status(400).json({ error: 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET first, then redeploy.' });
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    try {
      const out = await tg.call('setWebhook', {
        url: `https://${host}/api/telegram`,
        secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['callback_query', 'message']
      });
      return res.json({ ok: true, webhook: `https://${host}/api/telegram`, telegram: out,
        adminConfigured: !!process.env.TELEGRAM_ADMIN_ID });
    } catch (e) { return res.status(502).json({ error: e.message }); }
  }

  if (req.method !== 'POST') return res.status(405).end();

  // Telegram retries anything that isn't a 200, so past this point we always answer 200.
  if (!checkPassword(req.headers['x-telegram-bot-api-secret-token'], process.env.TELEGRAM_WEBHOOK_SECRET))
    return res.status(401).end();

  try {
    const u = req.body || {};

    /* plain message: help the admin discover their own id during setup */
    if (u.message && u.message.text && /^\/(start|id)\b/.test(u.message.text)) {
      await tg.sendText(u.message.chat.id,
        `Your Telegram ID is: ${u.message.from.id}\n\nPut this in the TELEGRAM_ADMIN_ID environment variable on Vercel, then redeploy.`);
      return res.status(200).json({ ok: true });
    }

    const cb = u.callback_query;
    if (!cb || !cb.data) return res.status(200).json({ ok: true });

    if (String(cb.from && cb.from.id) !== tg.adminId()) {
      await tg.answer(cb.id, 'Not allowed.');
      return res.status(200).json({ ok: true });
    }

    const [kind, reqId, idx] = cb.data.split(':');
    const chat = cb.message && cb.message.chat.id, msg = cb.message && cb.message.message_id;

    if (kind === 'r') {                                   // reject → pick a reason
      await tg.setKeyboard(chat, msg, tg.rejectKeyboard(reqId));
      await tg.answer(cb.id, 'Pick a reason');
    } else if (kind === 'b') {                            // back to approve/reject
      await tg.setKeyboard(chat, msg, tg.approvalKeyboard(reqId));
      await tg.answer(cb.id);
    } else if (kind === 'a' || kind === 'x') {
      const reason = kind === 'x' ? tg.REJECT_REASONS[Number(idx)] : undefined;
      const out = await resolveRequest(reqId, kind === 'a' ? 'approve' : 'reject', reason, 'Telegram');
      if (out.body.error) await tg.answer(cb.id, `⚠ ${out.body.error}`);
      else if (out.body.alreadyResolved) {
        await tg.answer(cb.id, 'Already handled.');
        // buttons may still be showing if the earlier edit failed — clear them
        await tg.setKeyboard(chat, msg, { inline_keyboard: [] });
      } else await tg.answer(cb.id, kind === 'a' ? '✅ Approved' : '❌ Rejected');
    } else await tg.answer(cb.id);
  } catch (e) {
    console.error('telegram webhook error:', e);
  }
  return res.status(200).json({ ok: true });
};
