const path = require('path');
require('dotenv').config(); // telegram-bot/.env → TELEGRAM_TOKEN, ANTHROPIC_API_KEY
require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); // AIOS/.env → SUPABASE_* (shared, not overridden)
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const { runAgent } = require('../AI-OS/agent.js'); // shared Lani brain (voice orb uses the same)

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Simple per-chat memory (kept in RAM; cleared on restart). Lets Lani remember
// the conversation instead of treating every message as brand new.
const histories = new Map();

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  const history = histories.get(chatId) || [];

  try {
    await bot.sendChatAction(chatId, 'typing');
    const { reply, history: newHistory } = await runAgent(text, history, { voice: false });

    // Store only the clean text history the agent hands back (never tool blocks).
    histories.set(chatId, newHistory);

    await bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, 'Something went wrong. Try again.');
  }
});

console.log('Lani (Telegram) is running...');
