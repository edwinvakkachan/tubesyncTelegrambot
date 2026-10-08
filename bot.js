require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const {
  extractYoutubeId,
  extractYoutubePlaylistId,
  extractVideoIdsFromPlaylistHtml,
} = require('./utils/youtube');

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

const PLAYLIST_FETCH_TIMEOUT_MS = 15000;
const YOUTUBE_WEB_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

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

function parseJsonAfter(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return null;

  const start = text.indexOf('{', markerIndex + marker.length);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;

      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function collectPlaylistData(value, ids = new Set(), continuations = new Set()) {
  if (!value || typeof value !== 'object') {
    return { ids, continuations };
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPlaylistData(item, ids, continuations);
    }

    return { ids, continuations };
  }

  const playlistVideoId = value.playlistVideoRenderer?.videoId;
  if (/^[A-Za-z0-9_-]{11}$/.test(playlistVideoId || '')) {
    ids.add(playlistVideoId);
  }

  const continuationToken =
    value.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
  if (continuationToken) {
    continuations.add(continuationToken);
  }

  for (const child of Object.values(value)) {
    collectPlaylistData(child, ids, continuations);
  }

  return { ids, continuations };
}

async function fetchPlaylistContinuation(token, config) {
  if (!config?.INNERTUBE_API_KEY) return null;

  const context = config.INNERTUBE_CONTEXT || {
    client: {
      clientName: 'WEB',
      clientVersion: config.INNERTUBE_CLIENT_VERSION || '2.20240101.00.00',
    },
  };

  const { data } = await axios.post(
    `https://www.youtube.com/youtubei/v1/browse?key=${encodeURIComponent(config.INNERTUBE_API_KEY)}`,
    { context, continuation: token },
    {
      timeout: PLAYLIST_FETCH_TIMEOUT_MS,
      headers: YOUTUBE_WEB_HEADERS,
    }
  );

  return data;
}

async function fetchPlaylistVideoIds(playlistId) {
  const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
  const { data } = await axios.get(url, {
    timeout: PLAYLIST_FETCH_TIMEOUT_MS,
    headers: YOUTUBE_WEB_HEADERS,
  });

  const config = parseJsonAfter(data, 'ytcfg.set(');
  const initialData =
    parseJsonAfter(data, 'var ytInitialData =') ||
    parseJsonAfter(data, 'ytInitialData =');

  const ids = new Set();
  const continuations = new Set();

  if (initialData) {
    collectPlaylistData(initialData, ids, continuations);
  }

  if (!ids.size) {
    for (const id of extractVideoIdsFromPlaylistHtml(data)) {
      ids.add(id);
    }
  }

  const seenContinuations = new Set();
  const queue = Array.from(continuations);

  while (queue.length) {
    const token = queue.shift();
    if (seenContinuations.has(token)) continue;

    seenContinuations.add(token);
    const continuationData = await fetchPlaylistContinuation(token, config);
    if (!continuationData) continue;

    const nextIds = new Set();
    const nextContinuations = new Set();
    collectPlaylistData(continuationData, nextIds, nextContinuations);

    for (const id of nextIds) {
      ids.add(id);
    }

    for (const nextToken of nextContinuations) {
      if (!seenContinuations.has(nextToken)) {
        queue.push(nextToken);
      }
    }
  }

  return Array.from(ids);
}

async function addQueueItems(rows) {
  const { error } = await supabase
    .from('youtube_queue')
    .insert(rows);

  if (error) throw error;
}

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

  const playlistId = extractYoutubePlaylistId(text);

  if (playlistId) {
    try {
      const videoIds = await fetchPlaylistVideoIds(playlistId);

      if (!videoIds.length) {
        return bot.sendMessage(
          chatId,
          '⚠️ I found a playlist link, but could not extract any videos from it.'
        );
      }

      await addQueueItems(
        videoIds.map((youtubeId) => ({
          youtube_id: youtubeId,
          original_input: text,
          status: 'pending',
        }))
      );

      log(`Stored playlist in Supabase: ${playlistId} (${videoIds.length} videos)`);

      return bot.sendMessage(
        chatId,
        `✅ Added ${videoIds.length} playlist videos to queue.`
      );
    } catch (e) {
      err('Playlist import failed:', e.message);

      return bot.sendMessage(
        chatId,
        `❌ Failed to import playlist:\n${e.message}`
      );
    }
  }

  const youtubeId = extractYoutubeId(text);

  if (!youtubeId) {
    return bot.sendMessage(
      chatId,
      '⚠️ Please send a valid YouTube link or ID.'
    );
  }

  try {
    await addQueueItems([
      {
        youtube_id: youtubeId,
        original_input: text,
        status: 'pending',
      },
    ]);

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
