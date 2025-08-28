// bot.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { extractYoutubeId } = require('./utils/youtube');

// ---------- Logging helpers (IST) ----------
const TZ = 'Asia/Kolkata';
const ts = () =>
  new Date().toLocaleString('en-IN', {
    timeZone: TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const log = (...args) => console.log(`[${ts()}]`, ...args);
const warn = (...args) => console.warn(`[${ts()}] ⚠️`, ...args);
const err = (...args) => console.error(`[${ts()}] ❌`, ...args);

// ---------- Env ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const API_TOKEN = process.env.API_TOKEN;
const TUBE_API_URL = process.env.TUBE_API_URL;

if (!TELEGRAM_TOKEN || !API_TOKEN || !TUBE_API_URL) {
  err('Missing env vars: TELEGRAM_TOKEN, API_TOKEN, or TUBE_API_URL');
  process.exit(1);
}

log('Starting bot with polling…');

// ---------- Bot ----------
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on('polling_error', (e) => err('Polling error:', e?.message || e));

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const who =
    msg.from?.username
      ? `@${msg.from.username} (${msg.from.id})`
      : `${msg.from?.first_name || 'User'} (${msg.from?.id || 'id?'})`;

  if (!text) return;

  log(`Message received from ${who} in chat ${chatId}: "${text}"`);

  if (text === '/start') {
    log('Handled /start for', who);
    return bot.sendMessage(
      chatId,
      'Send me a YouTube link or 11-char video ID to start a download.'
    );
  }

  // ----- Link received -----
  log('Link/text received:', text);

  const youtubeId = extractYoutubeId(text);

  if (!youtubeId) {
    warn('Could not parse a YouTube ID from message.');
    return bot.sendMessage(chatId, '⚠️ Please send a valid YouTube video link or 11-char ID.');
  }

  log('Parsed YouTube ID:', youtubeId);

  // ----- Start download -----
  const payload = { data: [{ youtube_id: youtubeId, status: 'pending' }] };

  log('Starting download request →', TUBE_API_URL, 'payload:', payload);

  try {
    const startedAt = Date.now();

    const res = await axios.post(TUBE_API_URL, payload, {
      headers: {
        Authorization: `Token ${API_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 15000,
      // Never log sensitive headers
      validateStatus: (s) => s >= 200 && s < 500, // let us log 4xx bodies
    });

    const ms = Date.now() - startedAt;
    if (res.status >= 200 && res.status < 300) {
      log(`Download trigger succeeded (HTTP ${res.status}) in ${ms}ms for ID ${youtubeId}`);
      bot.sendMessage(chatId, `✅ Download started for YouTube ID: ${youtubeId}`);
    } else {
      warn(
        `Download trigger returned HTTP ${res.status} in ${ms}ms for ID ${youtubeId}. Body:`,
        JSON.stringify(res.data, null, 2)
      );
      bot.sendMessage(
        chatId,
        `⚠️ Server responded with ${res.status}:\n${JSON.stringify(res.data, null, 2)}`
      );
    }
  } catch (error) {
    // Network/timeout or thrown errors
    const msgText =
      error.response?.data ?? error.message ?? 'Unknown error (no message from server)';
    err('Download trigger failed:', msgText);
    bot.sendMessage(
      chatId,
      `❌ Failed to trigger download:\n${
        typeof msgText === 'string' ? msgText : JSON.stringify(msgText, null, 2)
      }`
    );
  }
});

// ---------- Graceful shutdown ----------
process.once('SIGINT', () => {
  log('SIGINT received, stopping polling…');
  bot.stopPolling().finally(() => log('Polling stopped. Bye!'));
});
process.once('SIGTERM', () => {
  log('SIGTERM received, stopping polling…');
  bot.stopPolling().finally(() => log('Polling stopped. Bye!'));
});
