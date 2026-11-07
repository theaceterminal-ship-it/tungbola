/* Thin Telegram Bot API helper. Payment screenshots are sent straight from
   the purchase request to the admin's Telegram chat and are NEVER written to
   our own storage (no Blob, no Redis) — Telegram holds the image, we only
   keep the text of the request. Everything here is best-effort-safe: callers
   decide what a failure means.

   Env vars:
     TELEGRAM_BOT_TOKEN       from @BotFather
     TELEGRAM_ADMIN_ID        numeric Telegram user id of the person who approves
     TELEGRAM_WEBHOOK_SECRET  any random string; Telegram echoes it on every webhook call
*/
const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN = () => String(process.env.TELEGRAM_ADMIN_ID || '').trim();

function configured() { return !!(TOKEN() && ADMIN()); }
function adminId() { return ADMIN(); }

async function call(method, payload, isForm) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN()}/${method}`, isForm
    ? { method: 'POST', body: payload }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(`Telegram ${method} failed: ${data.description || r.status}`);
  return data.result;
}

function approvalKeyboard(reqId) {
  return { inline_keyboard: [[
    { text: '✅ Approve', callback_data: `a:${reqId}` },
    { text: '❌ Reject', callback_data: `r:${reqId}` }
  ]] };
}

const REJECT_REASONS = [
  'Amount received does not match the plan price.',
  'Payment not received yet. Please try again or contact us.',
  'Screenshot is unclear. Please send a clear screenshot.'
];
function rejectKeyboard(reqId) {
  return { inline_keyboard: [
    ...REJECT_REASONS.map((t, i) => [{ text: `${i + 1}. ${t.replace(/\.$/, '')}`.slice(0, 60), callback_data: `x:${reqId}:${i}` }]),
    [{ text: '⬅ Back', callback_data: `b:${reqId}` }]
  ] };
}

/* Sends the proof to the admin. With an image: sendPhoto. Without one (₹0
   renewals fully covered by wallet credit): a plain message. Returns
   {chat, msg}. */
async function sendProof({ buffer, mime, caption, reqId }) {
  const chat = ADMIN();
  if (buffer) {
    const fd = new FormData();
    fd.append('chat_id', chat);
    fd.append('caption', caption.slice(0, 1020));
    fd.append('reply_markup', JSON.stringify(approvalKeyboard(reqId)));
    fd.append('photo', new Blob([buffer], { type: mime || 'image/jpeg' }), 'payment-proof');
    const m = await call('sendPhoto', fd, true);
    return { chat, msg: m.message_id };
  }
  const m = await call('sendMessage', { chat_id: chat, text: caption, reply_markup: approvalKeyboard(reqId) });
  return { chat, msg: m.message_id };
}

/* Rewrites the decision onto the original message and removes the buttons so
   it can't be pressed twice. Photo messages carry a caption, text messages
   carry text — try the right one, never throw. */
async function finalize(chat, msg, text, hadPhoto) {
  if (!chat || !msg) return;
  try {
    if (hadPhoto) await call('editMessageCaption', { chat_id: chat, message_id: msg, caption: text.slice(0, 1020), reply_markup: { inline_keyboard: [] } });
    else await call('editMessageText', { chat_id: chat, message_id: msg, text, reply_markup: { inline_keyboard: [] } });
  } catch (e) { console.error('Telegram finalize failed:', e.message); }
}

const answer = (id, text) => call('answerCallbackQuery', { callback_query_id: id, text: (text || '').slice(0, 190) }).catch(() => {});
const setKeyboard = (chat, msg, kb) => call('editMessageReplyMarkup', { chat_id: chat, message_id: msg, reply_markup: kb }).catch(() => {});
const sendText = (chat, text) => call('sendMessage', { chat_id: chat, text }).catch(() => {});

module.exports = { configured, adminId, sendProof, finalize, answer, setKeyboard, sendText, call, approvalKeyboard, rejectKeyboard, REJECT_REASONS };
