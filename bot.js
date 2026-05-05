require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const { extractYoutubeId } = require('./utils/youtube');

// ---------- Logging helpers ----------
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
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!TELEGRAM_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  err('Missing env vars');
  process.exit(1);
}

// ---------- Supabase ----------
const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

log('Starting bot with polling...');

// ---------- Bot ----------
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on('polling_error', (e) => err('Polling error:', e?.message || e));

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (!text) return;

  if (text === '/start') {
    return bot.sendMessage(
      chatId,
      'Send me a YouTube link or video ID to queue it.'
    );
  }

  const youtubeId = extractYoutubeId(text);

  if (!youtubeId) {
    return bot.sendMessage(
      chatId,
      '⚠️ Please send a valid YouTube link or ID.'
    );
  }

  try {
    const { error } = await supabase
      .from('youtube_queue')
      .insert([
        {
          youtube_id: youtubeId,
          original_input: text,
          status: 'pending',
        },
      ]);

    if (error) throw error;

    log('Stored in Supabase:', youtubeId);

    bot.sendMessage(
      chatId,
      `✅ Added to queue: ${youtubeId}`
    );
  } catch (e) {
    err('Supabase insert failed:', e.message);

    bot.sendMessage(
      chatId,
      `❌ Failed to save queue item:\n${e.message}`
    );
  }
});

// ---------- Graceful shutdown ----------
process.once('SIGINT', () => {
  log('SIGINT received, stopping polling...');
  bot.stopPolling().finally(() => log('Stopped.'));
});

process.once('SIGTERM', () => {
  log('SIGTERM received, stopping polling...');
  bot.stopPolling().finally(() => log('Stopped.'));
});