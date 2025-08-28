// bot.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { extractYoutubeId } = require('./utils/youtube');

// === [ADDED] durable queue deps ===
const fs = require('fs');
const path = require('path');

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

// === [ADDED] tiny file-backed queue ===
const DATA_DIR = path.join(__dirname, 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.jsonl'); // one JSON per line

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(QUEUE_FILE)) fs.writeFileSync(QUEUE_FILE, '');

const readQueue = () =>
  fs
    .readFileSync(QUEUE_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const writeQueue = (items) => {
  const body = items.map((i) => JSON.stringify(i)).join('\n');
  fs.writeFileSync(QUEUE_FILE, body + (items.length ? '\n' : ''));
};

const appendQueue = (item) => fs.appendFileSync(QUEUE_FILE, JSON.stringify(item) + '\n');

const enqueueIfNew = ({ youtubeId, chatId }) => {
  const items = readQueue();
  if (items.some((x) => x.youtubeId === youtubeId && x.status !== 'failed')) return false;
  appendQueue({
    youtubeId,
    chatId,
    status: 'pending',
    attempts: 0,
    lastError: null,
    // backoff scheduling
    nextAttemptAt: 0,
    createdAtIST: ts(),
    updatedAtIST: ts(),
  });
  return true;
};

// Reusable request (matches your current payload & headers)  :contentReference[oaicite:1]{index=1}
async function postToTubeArchivist(youtubeId) {
  const payload = { data: [{ youtube_id: youtubeId, status: 'pending' }] };
  return axios.post(TUBE_API_URL, payload, {
    headers: {
      Authorization: `Token ${API_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 15000,
    validateStatus: (s) => s >= 200 && s < 500, // keep your current behavior
  });
}

// Exponential backoff (0s, 5s, 15s, 45s, ... capped)
const backoffSeconds = (attempts) => Math.min(300, attempts === 0 ? 0 : 5 * Math.pow(3, attempts - 1));

// Periodic queue drainer
async function drainQueueOnce() {
  let items = readQueue();
  const pending = items.filter((x) => x.status === 'pending' && Date.now() >= (x.nextAttemptAt || 0));
  if (!pending.length) return;

  log(`Queue: processing ${pending.length} pending entr${pending.length > 1 ? 'ies' : 'y'}…`);

  for (const job of pending) {
    try {
      const started = Date.now();
      const res = await postToTubeArchivist(job.youtubeId);
      const ms = Date.now() - started;

      items = readQueue(); // re-read to remain consistent
      const idx = items.findIndex((x) => x.youtubeId === job.youtubeId && x.status === 'pending');
      if (idx === -1) continue;

      if (res.status >= 200 && res.status < 300) {
        log(`✅ Queue drain OK (HTTP ${res.status}) in ${ms}ms for ${job.youtubeId}`);
        // success: mark done and notify the original chat, once
        items[idx].status = 'done';
        items[idx].updatedAtIST = ts();
        writeQueue(items);
        // Notify user only on first success from the queue
        if (job.chatId) {
          bot.sendMessage(job.chatId, `✅ Download started for YouTube ID: ${job.youtubeId}`);
        }
      } else {
        // treat non-2xx as retryable; schedule next time
        const attempts = (items[idx].attempts || 0) + 1;
        const delay = backoffSeconds(attempts);
        items[idx].attempts = attempts;
        items[idx].lastError = `HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 400)}`;
        items[idx].nextAttemptAt = Date.now() + delay * 1000;
        items[idx].updatedAtIST = ts();
        writeQueue(items);
        warn(`Queue drain: HTTP ${res.status} for ${job.youtubeId}. Retry in ${delay}s.`);
      }
    } catch (e) {
      items = readQueue();
      const idx = items.findIndex((x) => x.youtubeId === job.youtubeId && x.status === 'pending');
      if (idx !== -1) {
        const attempts = (items[idx].attempts || 0) + 1;
        const delay = backoffSeconds(attempts);
        items[idx].attempts = attempts;
        items[idx].lastError = (e?.message || String(e)).slice(0, 400);
        items[idx].nextAttemptAt = Date.now() + delay * 1000;
        items[idx].updatedAtIST = ts();
        writeQueue(items);
      }
      warn(`Queue drain error for ${job.youtubeId}:`, e?.message || e);
    }
  }
}

// Run every 8s (tune if you like)
setInterval(drainQueueOnce, 8000);

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

  // ----- Start download (original behavior first) -----
  try {
    const startedAt = Date.now();
    const res = await postToTubeArchivist(youtubeId);
    const ms = Date.now() - startedAt;

    if (res.status >= 200 && res.status < 300) {
      log(`Download trigger succeeded (HTTP ${res.status}) in ${ms}ms for ID ${youtubeId}`);
      return bot.sendMessage(chatId, `✅ Download started for YouTube ID: ${youtubeId}`);
    }

    // === [ADDED] offline / non-2xx → queue it ===
    warn(
      `Immediate trigger got HTTP ${res.status} in ${ms}ms for ${youtubeId}. Queuing for retry. Body:`,
      JSON.stringify(res.data, null, 2)
    );
    const queued = enqueueIfNew({ youtubeId, chatId });
    return bot.sendMessage(
      chatId,
      queued
        ? `📥 TubeArchivist seems unavailable. I queued your link (${youtubeId}); I'll retry automatically.`
        : `ℹ️ Already queued: ${youtubeId}. I'll retry automatically.`
    );

  } catch (error) {
    // === [ADDED] network error/timeout → queue it ===
    const msgText = error.response?.data ?? error.message ?? 'Unknown error';
    err('Download trigger failed, queuing:', msgText);
    const queued = enqueueIfNew({ youtubeId, chatId });
    return bot.sendMessage(
      chatId,
      queued
        ? `📥 TubeArchivist seems offline. I queued your link (${youtubeId}); I'll retry automatically.`
        : `ℹ️ Already queued: ${youtubeId}. I'll retry automatically.`
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
