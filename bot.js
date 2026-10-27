const path = require('path');
require('dotenv').config(); // telegram-bot/.env → TELEGRAM_TOKEN, ANTHROPIC_API_KEY, ALLOWED_CHAT_IDS
require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); // AIOS/.env → SUPABASE_* (shared, not overridden)
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const { runAgent, describeFailure } = require('../AI-OS/agent.js'); // shared brain (the voice orb runs Lani off the same file)

// Allowlist: only these Telegram chat IDs may drive the manager. Comma-separated in
// .env, e.g. ALLOWED_CHAT_IDS=12345678. Hard security boundary — the bot can
// create invoices, take payments and book jobs in the live database, so keep
// this locked.
const ALLOWED = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Simple per-chat memory (kept in RAM; cleared on restart). Lets the manager
// remember the conversation instead of treating every message as brand new.
const histories = new Map();

// Chats with a write preview waiting on a yes/no. The next message in one of
// these is the approval, so it runs on the careful model instead of the cheap
// one — see the model-tiering note in agent.js. Cleared on restart, which is
// correct: a restart also invalidates the confirm tokens.
const awaitingConfirm = new Set();

// Telegram caps messages at 4096 chars; chunk long replies.
async function sendLong(chatId, text) {
  const LIMIT = 4000;
  for (let i = 0; i < text.length; i += LIMIT) {
    await bot.sendMessage(chatId, text.slice(i, i + LIMIT));
  }
}

bot.on('message', async (msg) => {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  if (!text) return;

  // Security bootstrap: if no allowlist set, tell the owner their chat ID.
  if (ALLOWED.length === 0) {
    await bot.sendMessage(chatId,
      `Locked. Your chat ID is ${chatId}.\nAdd ALLOWED_CHAT_IDS=${chatId} to telegram-bot/.env and restart.`);
    return;
  }
  if (!ALLOWED.includes(chatId)) {
    await bot.sendMessage(chatId, 'Not authorized.');
    console.warn(`Blocked chat ${chatId}`);
    return;
  }

  // /reset or /new clears this chat's memory.
  if (text === '/reset' || text === '/new') {
    histories.delete(chatId);
    awaitingConfirm.delete(chatId);
    await bot.sendMessage(chatId, 'Fresh conversation started.');
    return;
  }

  // Outbound call approval gate. scripts/outbound_call.py (AI-OS) texts Jake
  // "Reply APPROVE <id> or CANCEL <id>" and waits on call_queue.approval. This
  // bot owns Telegram's getUpdates stream, so it records the answer; the script
  // never polls Telegram. Only counts while the row is queued and was asked.
  const gate = text.match(/^(approve|cancel)\s+#?(\d+)\s*$/i);
  if (gate) {
    const approved = gate[1].toLowerCase() === 'approve';
    const id = gate[2];
    try {
      const url = `${(process.env.SUPABASE_URL || '').replace(/\/$/, '')}/rest/v1/call_queue` +
        `?id=eq.${id}&status=eq.queued&approval_asked_at=not.is.null&approval=is.null`;
      const r = await fetch(url, {
        method: 'PATCH',
        headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ approval: approved ? 'approved' : 'denied' }),
      });
      const rows = r.ok ? await r.json() : [];
      if (rows.length) {
        await bot.sendMessage(chatId, approved ? `Approved call #${id}. Dialing.` : `Call #${id} cancelled.`);
        return;
      }
      // Not waiting on an answer. Fall through if it was not an outbound-call
      // reply at all; say so when it clearly was.
      await bot.sendMessage(chatId, `Call #${id} is not waiting for an answer (already handled, timed out, or not queued).`);
      return;
    } catch (e) {
      await bot.sendMessage(chatId, `Could not record that answer (${e.message}). The call will not dial.`);
      return;
    }
  }

  const history = histories.get(chatId) || [];

  try {
    await bot.sendChatAction(chatId, 'typing');
    const keepTyping = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 5000);

    // 'manager' = the HI Grade Manager: read/write on the invoicing app and the
    // job schedule. Every write is preview-then-confirm inside agent-writes.js.
    const { reply, history: newHistory, pendingWrite, model } = await runAgent(text, history, {
      voice: false,
      agent: 'manager',
      escalate: awaitingConfirm.has(chatId),
    });

    clearInterval(keepTyping);

    // Store only the clean text history the agent hands back (never tool blocks).
    histories.set(chatId, newHistory);
    if (pendingWrite) awaitingConfirm.add(chatId);
    else awaitingConfirm.delete(chatId);
    console.log(`${chatId} ${model}${pendingWrite ? ' (awaiting confirm)' : ''}`);

    await sendLong(chatId, reply);
  } catch (err) {
    // One scannable line first, then the full object. Grepping the log for
    // 'FAILED' beats scrolling past a 40-line SDK dump to find the cause.
    console.error(`FAILED ${new Date().toISOString()} status=${err?.status ?? '-'}: ${err?.message || err}`);
    console.error(err);
    await bot.sendMessage(chatId, describeFailure(err));
  }
});

console.log('HI Grade Manager (Telegram) is running. Brain =', path.join(__dirname, '..', 'AI-OS', 'agent.js'));
console.log(ALLOWED.length ? `Allowlist: ${ALLOWED.join(', ')}` : 'NO ALLOWLIST SET — bot is locked until ALLOWED_CHAT_IDS is set.');
