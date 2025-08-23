// bot.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { extractYoutubeId } = require('./utils/youtube');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const API_TOKEN = process.env.API_TOKEN;
const TUBE_API_URL = process.env.TUBE_API_URL;

if (!TELEGRAM_TOKEN || !API_TOKEN || !TUBE_API_URL) {
  console.error('Missing env vars: TELEGRAM_TOKEN, API_TOKEN, TUBE_API_URL');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;

  if (text === '/start') {
    return bot.sendMessage(
      chatId,
      'Send me a YouTube link or 11‑char video ID to start a download.'
    );
  }

  const youtubeId = extractYoutubeId(text);

  if (!youtubeId) {
    return bot.sendMessage(chatId, '⚠️ Please send a valid YouTube video link or 11‑char ID.');
  }

  try {
    await axios.post(
      TUBE_API_URL,
      { data: [{ youtube_id: youtubeId, status: 'pending' }] },
      {
        headers: {
          Authorization: `Token ${API_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 15000,
      }
    );
    bot.sendMessage(chatId, `✅ Download started for YouTube ID: ${youtubeId}`);
  } catch (error) {
    const payload = error.response?.data ?? error.message;
    const msgText = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    bot.sendMessage(chatId, `❌ Failed to trigger download:\n${msgText}`);
  }
});

// graceful shutdown
process.once('SIGINT', () => bot.stopPolling());
process.once('SIGTERM', () => bot.stopPolling());
