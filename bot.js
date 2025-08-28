// npm i node-telegram-bot-api axios
// ENV required: TELEGRAM_BOT_TOKEN, TUBESYNC_URL, TUBESYNC_API_KEY

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

// ---------- Config ----------
const {
  TELEGRAM_BOT_TOKEN,
  TUBESYNC_URL,          // e.g. http://tubesync:4848  (or http://localhost:4848)
  TUBESYNC_API_KEY,      // put your TubeSync API key if required; else leave blank
  POLL_INTERVAL_MS = 8000,
  HEALTHCHECK_PATH = '/health' // change to whatever TubeSync exposes; '/' also fine
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TUBESYNC_URL) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TUBESYNC_URL env.');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.jsonl');
const tz = 'Asia/Kolkata';
const nowIST = () =>
  new Date().toLocaleString('en-IN', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(QUEUE_FILE)) fs.writeFileSync(QUEUE_FILE, '');

// ---------- Helpers ----------
function log(msg) { console.log(`[${nowIST()}] ${msg}`); }
function hr() { console.log(''.padEnd(60, '─')); }

const YT_REGEX = /(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_\-]{6,})/i;
function extractVideoId(url) {
  try {
    const m = url.match(YT_REGEX);
    if (!m) return null;
    // group 4 tries to capture ID for both formats
    if (m[4]) return m[4];
    const u = new URL(url);
    return u.searchParams.get('v');
  } catch { return null; }
}

function readAll() {
  const lines = fs.readFileSync(QUEUE_FILE, 'utf8').split('\n').filter(Boolean);
  return lines.map(l => JSON.parse(l));
}

function append(item) {
  fs.appendFileSync(QUEUE_FILE, JSON.stringify(item) + '\n');
}

function rewrite(items) {
  const data = items.map(i => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '');
  fs.writeFileSync(QUEUE_FILE, data);
}

function uniqueKey(id) { return id; } // by videoId; adjust if you also queue channels/playlists

function alreadyQueuedOrDone(items, id) {
  return items.some(x => x.videoId === id && (x.status === 'pending' || x.status === 'done'));
}

// ---------- Telegram Bot ----------
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // Extract all YT links from the message (support multiple links in one msg)
  const urls = Array.from(new Set((text.match(/https?:\/\/\S+/g) || []).filter(u => YT_REGEX.test(u))));

  if (!urls.length) return; // ignore non-URL messages

  const items = readAll();
  let added = 0, skipped = 0;

  for (const url of urls) {
    const videoId = extractVideoId(url);
    if (!videoId) { skipped++; continue; }

    if (alreadyQueuedOrDone(items, videoId)) {
      skipped++;
      continue;
    }

    const job = {
      id: uniqueKey(videoId),
      videoId,
      url,
      status: 'pending',
      attempts: 0,
      lastError: null,
      createdAtIST: nowIST(),
      updatedAtIST: nowIST(),
    };
    append(job);
    added++;
  }

  await bot.sendMessage(
    chatId,
    `✅ Received ${added} link(s). ${skipped ? `Skipped ${skipped} (duplicate/invalid). ` : ''}They’ll be sent to TubeSync when it’s reachable.`
  );

  log(`Telegram: queued=${added} skipped=${skipped}`);
});

// ---------- TubeSync integration (CUSTOMIZE this) ----------
// Implement how to "add a link" to TubeSync in your setup.
// Replace this stub with the actual TubeSync API endpoint your instance uses.
async function sendToTubeSync({ url, videoId }) {
  // Example placeholder POST. Adjust path/body/headers as per your TubeSync version.
  // Many setups accept something like POST /api/urls with { url }
  const endpoint = new URL('/api/urls', TUBESYNC_URL).toString();

  const headers = {};
  if (TUBESYNC_API_KEY) headers['Authorization'] = `Bearer ${TUBESYNC_API_KEY}`;

  // If TubeSync returns 409 on duplicates, we treat that as success (idempotent).
  const res = await axios.post(endpoint, { url }, { headers, validateStatus: () => true });
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
  if (res.status === 409) return { ok: true, status: 409, duplicate: true };

  // Non-success
  const errText = res.data && typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data || '');
  return { ok: false, status: res.status, error: errText.slice(0, 400) };
}

async function isUp() {
  try {
    const url = new URL(HEALTHCHECK_PATH, TUBESYNC_URL).toString();
    const res = await axios.get(url, { timeout: 3000, validateStatus: () => true });
    return res.status >= 200 && res.status < 500; // allow 4xx: app is up but route might not exist
  } catch { return false; }
}

// ---------- Worker loop ----------
let running = false;

async function drainQueue() {
  if (running) return;
  running = true;

  try {
    const alive = await isUp();
    if (!alive) {
      log('TubeSync seems offline; will retry later.');
      return;
    }

    let items = readAll();
    const pending = items.filter(x => x.status === 'pending');

    if (!pending.length) return;

    hr();
    log(`Draining queue: ${pending.length} pending`);

    let sent = 0, failed = 0;

    for (const job of pending) {
      // exponential backoff: attempts 0,1,2,3… → delay 0s, 5s, 15s, 45s, …
      const delaySec = Math.min(60 * 5, Math.floor(5 * Math.pow(3, Math.max(0, job.attempts - 0))));
      const tooSoon = job.attempts > 0 && job.nextAttemptAt && Date.now() < job.nextAttemptAt;

      if (tooSoon) continue;

      try {
        const res = await sendToTubeSync({ url: job.url, videoId: job.videoId });

        items = readAll(); // re-read to keep in sync if multiple workers ever run
        const idx = items.findIndex(x => x.id === job.id);
        if (idx === -1) continue;

        if (res.ok) {
          items[idx].status = 'done';
          items[idx].updatedAtIST = nowIST();
          items[idx].lastError = null;
          items[idx].attempts++;
          delete items[idx].nextAttemptAt;
          rewrite(items);
          sent++;
          log(`✅ Pushed ${job.videoId}${res.duplicate ? ' (duplicate acknowledged)' : ''}`);
        } else {
          items[idx].status = 'pending'; // keep pending
          items[idx].attempts++;
          items[idx].lastError = `HTTP ${res.status} ${res.error || ''}`;
          items[idx].updatedAtIST = nowIST();
          items[idx].nextAttemptAt = Date.now() + delaySec * 1000;
          rewrite(items);
          failed++;
          log(`❌ Failed ${job.videoId}: ${items[idx].lastError}. Will retry in ${delaySec}s.`);
        }

      } catch (e) {
        items = readAll();
        const idx = items.findIndex(x => x.id === job.id);
        if (idx !== -1) {
          items[idx].status = 'pending';
          items[idx].attempts++;
          items[idx].lastError = e.message.slice(0, 400);
          items[idx].updatedAtIST = nowIST();
          const delaySec = Math.min(60 * 5, Math.floor(5 * Math.pow(3, Math.max(0, items[idx].attempts - 1))));
          items[idx].nextAttemptAt = Date.now() + delaySec * 1000;
          rewrite(items);
        }
        failed++;
        log(`❌ Error pushing ${job.videoId}: ${e.message}`);
      }
    }

    log(`Summary: sent=${sent} failed=${failed} remaining=${readAll().filter(x => x.status==='pending').length}`);
    hr();
  } finally {
    running = false;
  }
}

setInterval(drainQueue, Number(POLL_INTERVAL_MS));
log(`Service started. Polling every ${POLL_INTERVAL_MS}ms. Timezone IST.`);

// Optional: command to show queue stats via Telegram
bot.onText(/\/queue/, (msg) => {
  const items = readAll();
  const pending = items.filter(x => x.status === 'pending').length;
  const done = items.filter(x => x.status === 'done').length;
  bot.sendMessage(msg.chat.id, `Queue → pending: ${pending}, done: ${done}`);
});
