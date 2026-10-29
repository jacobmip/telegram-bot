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

// ── AI ballpark estimate approval (web / SMS / Yelp leads) ────────────────
// higrade-invoicing/api/_lib/lead-estimate.js DMs Jake a proposal and parks it
// in invoices.estimator_items. "APPROVE EST1234" texts the customer the ballpark
// and swaps the proposal in for the generic line item; "DECLINE EST1234" does
// nothing else. Nothing reaches the customer before APPROVE.
const APP_URL = process.env.APP_URL || 'https://higrade-invoicing.vercel.app';
const SB = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/rest/v1';
const sbHeaders = (extra = {}) => ({
  apikey: process.env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

// visits[0].start / gcal_date are Hawaii wall-clock text, "YYYY-MM-DDTHH:MM".
// Parsed by hand: new Date(string) would shift it by this machine's zone.
function visitPhrase(inv) {
  const raw = (Array.isArray(inv.visits) && inv.visits[0]?.start) || inv.gcal_date || '';
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const day = d.toLocaleDateString('en-US', { weekday: 'long' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day} at ${time}`;
}

// Same math as calcItemTotal / calcTotals in higrade-invoicing/src/App.jsx.
function estimateTotal(inv, items) {
  const sub = items.reduce((s, it) => {
    const gross = (Number(it.qty) || 1) * (Number(it.price) || 0);
    if (!it.discount) return s + gross;
    return s + (it.discount_type === '%' ? gross * (1 - it.discount / 100) : Math.max(0, gross - it.discount));
  }, 0);
  const dv = Number(inv.discount) || 0;
  const disc = inv.discount_type === '%' ? sub * (dv / 100) : dv;
  const after = sub - disc;
  return (after + after * ((Number(inv.tax) || 0) / 100)).toFixed(2);
}

// Emails the estimate after the SMS. Returns a short note for the Telegram reply.
async function emailEstimate(invoiceId, smsInv) {
  const base = SB();
  const id = encodeURIComponent(invoiceId);
  const inv = (await (await fetch(
    `${base}/invoices?id=eq.${id}&select=id,client_id,client_name,client_info,view_token,tax,discount,discount_type&limit=1`,
    { headers: sbHeaders() })).json())[0];
  if (!inv) throw new Error('estimate not found');

  let email = (inv.client_info?.email || '').trim();
  if (!email && inv.client_id) {
    const c = (await (await fetch(`${base}/clients?id=eq.${inv.client_id}&select=email&limit=1`, { headers: sbHeaders() })).json())[0];
    email = (c?.email || '').trim();
  }
  if (!email) {
    console.log(`No email on file for ${invoiceId}`);
    return '';
  }

  let token = inv.view_token;
  if (!token) {
    token = require('crypto').randomBytes(9).toString('base64url');
    const p = await fetch(`${base}/invoices?id=eq.${id}`, {
      method: 'PATCH', headers: sbHeaders(), body: JSON.stringify({ view_token: token }) });
    if (!p.ok) throw new Error(`token save ${p.status}`);
  }

  const items = await (await fetch(
    `${base}/invoice_items?invoice_id=eq.${id}&select=price,qty,discount,discount_type`, { headers: sbHeaders() })).json();
  const total = estimateTotal(inv, Array.isArray(items) ? items : []);
  const named = !/no name given|missed call|unknown/i.test(inv.client_name || '');
  const first = named ? String(inv.client_name).trim().split(/\s+/)[0] : '';

  const r = await fetch(`${APP_URL}/api/send-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: email,
      invoiceId,
      clientName: inv.client_name || '',
      total,
      viewLink: `${APP_URL}/v/${token}`,
      bccAdmin: true,
      subject: `Estimate ${invoiceId} from HI Grade Plumbing`,
      message: `Aloha${first ? ' ' + first : ''},\n\nThank you for contacting HI Grade Plumbing. Your estimate ${invoiceId} is ready to review at the link above. Reply to this email or call/text 808-393-0015 with any questions.\n\nMahalo,\nHI Grade Plumbing`,
    }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok || out.error || out.statusCode >= 400) throw new Error(out.error || out.message || r.status);
  return `Emailed to ${email}.`;
}

async function handleEstimatorReply(chatId, approved, invoiceId) {
  const base = SB();
  const id = encodeURIComponent(invoiceId);
  // Atomic claim: only a proposal that is still waiting can be answered, once.
  const claim = await fetch(
    `${base}/invoices?id=eq.${id}&estimator_items=not.is.null&estimator_approval=is.null`,
    { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({ estimator_approval: approved ? 'approved' : 'declined' }) });
  const claimed = claim.ok ? await claim.json() : [];
  if (!claimed.length) {
    await bot.sendMessage(chatId, `${invoiceId} is not waiting on an estimate answer (already handled, or no proposal).`);
    return;
  }
  if (!approved) {
    await bot.sendMessage(chatId, `Declined ${invoiceId}. Nothing sent.`);
    return;
  }

  const revert = () => fetch(`${base}/invoices?id=eq.${id}`, {
    method: 'PATCH', headers: sbHeaders(), body: JSON.stringify({ estimator_approval: null }) }).catch(() => {});
  try {
    const inv = (await (await fetch(
      `${base}/invoices?id=eq.${id}&select=id,client_id,client_name,client_info,visits,gcal_date,estimator_items,invoice_items(id,name,price)&limit=1`,
      { headers: sbHeaders() })).json())[0];
    const prop = inv.estimator_items;
    let phone = inv.client_info?.phone || null;
    if (!phone && inv.client_id) {
      const c = (await (await fetch(`${base}/clients?id=eq.${inv.client_id}&select=phone&limit=1`, { headers: sbHeaders() })).json())[0];
      phone = c?.phone || null;
    }
    if (!phone) { await revert(); await bot.sendMessage(chatId, `${invoiceId}: no phone number on file, nothing sent. Still pending.`); return; }

    const settings = await (await fetch(`${base}/settings?key=eq.sms_webhook_secret&select=value&limit=1`, { headers: sbHeaders() })).json();
    const secret = settings?.[0]?.value;
    if (!secret) { await revert(); await bot.sendMessage(chatId, `${invoiceId}: sms_webhook_secret missing, nothing sent. Still pending.`); return; }

    const named = !/no name given|missed call|unknown/i.test(inv.client_name || '');
    const first = named ? String(inv.client_name).trim().split(/\s+/)[0] : '';
    const when = visitPhrase(inv);
    const parts = prop.items.map(it => `${it.name} ~${usd(it.price * (it.qty || 1))}`).join(', ');
    const body = prop.sms_body ||
      `Aloha${first ? ' ' + first : ''}, based on what you've described, here's a rough ballpark for the work: ${parts}. ` +
      `Total estimate: around ${usd(prop.total)} before tax. This is just a ballpark — the team will confirm the exact price when they come out. ` +
      (when ? `Does ${when} still work for you?` : 'What day works best for you?');

    const r = await fetch(`${APP_URL}/api/sms-inbound`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ to: phone, body, invoice_id: invoiceId }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) {
      await revert();
      await bot.sendMessage(chatId, `${invoiceId}: text NOT sent (${out.error || r.status}). Still pending, reply APPROVE again once fixed.`);
      return;
    }

    // Text is out. Now put the proposal on the document: add the new lines, then
    // drop the generic placeholder(s). Inserting first means a failure leaves
    // extra lines, never an empty estimate.
    let itemNote = 'Line items updated.';
    try {
      const old = (inv.invoice_items || []).filter(it => /service call|diagnostic/i.test(it.name || ''));
      const rows = prop.items.map((it, i) => ({
        invoice_id: invoiceId, name: it.name, description: it.desc || '',
        qty: it.qty || 1, price: it.price, unit: 'each', taxable: true, sort_order: i,
      }));
      const ins = await fetch(`${base}/invoice_items`, { method: 'POST', headers: sbHeaders(), body: JSON.stringify(rows) });
      if (!ins.ok) throw new Error(`insert ${ins.status}`);
      if (old.length) {
        const del = await fetch(`${base}/invoice_items?id=in.(${old.map(o => o.id).join(',')})`, { method: 'DELETE', headers: sbHeaders() });
        if (!del.ok) throw new Error(`delete ${del.status}`);
      }
    } catch (e) {
      itemNote = `Line items NOT fully updated (${e.message}) - check ${invoiceId} in the app.`;
    }
    // Email the estimate too. Runs after the line items are swapped so the total
    // matches the document. Never throws: the text already went out.
    let emailNote = '';
    try {
      emailNote = await emailEstimate(invoiceId, inv);
    } catch (e) {
      emailNote = `Email NOT sent (${e.message}).`;
    }
    await bot.sendMessage(chatId, `Approved ${invoiceId}. Ballpark texted to ${phone} (${usd(prop.total)}). ${itemNote} ${emailNote}`.trim());
  } catch (e) {
    await revert();
    await bot.sendMessage(chatId, `${invoiceId}: could not send (${e.message}). Still pending.`);
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

  // Ballpark estimate approval for web/SMS/Yelp leads (see handleEstimatorReply).
  const est = text.match(/^(approve|decline)\s+(EST\d{3,})\s*$/i);
  if (est) {
    try { await handleEstimatorReply(chatId, est[1].toLowerCase() === 'approve', est[2].toUpperCase()); }
    catch (e) { await bot.sendMessage(chatId, `Could not handle that (${e.message}).`); }
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
