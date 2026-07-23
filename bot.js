require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const contextDir = path.join(__dirname, '..', 'AIOS', 'context');

function loadContext() {
  try {
    const files = fs.readdirSync(contextDir).filter(f => f.endsWith('.md'));
    return files.map(f => {
      const content = fs.readFileSync(path.join(contextDir, f), 'utf8');
      return `--- ${f} ---\n${content}`;
    }).join('\n\n');
  } catch {
    return '';
  }
}

const systemPrompt = `You are Jake's personal AI executive assistant. You help him run his plumbing business and his life. Be direct, concise, and actionable. Short sentences. No fluff. Here is his personal context:\n\n${loadContext()}`;

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }],
    });

    await bot.sendMessage(chatId, response.content[0].text);
  } catch (err) {
    await bot.sendMessage(chatId, 'Something went wrong. Try again.');
    console.error(err);
  }
});

console.log('Bot is running...');
