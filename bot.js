require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const {
  extractYoutubeId,
  extractYoutubePlaylistId,
  extractYoutubePlaylistSeedId,
  extractVideoIdsFromPlaylistHtml,
  extractYoutubeChannel,
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
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const markerIndex = text.indexOf(marker, searchFrom);
    if (markerIndex === -1) return null;
    searchFrom = markerIndex + marker.length;

    const start = text.indexOf('{', searchFrom);
    if (start === -1) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break;
          }
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
    value.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
    value.continuationItemRenderer?.continuationEndpoint?.command?.continuationCommand?.token ||
    value.nextContinuationData?.continuation;
  if (continuationToken) {
    continuations.add(continuationToken);
  }

  for (const child of Object.values(value)) {
    collectPlaylistData(child, ids, continuations);
  }

  return { ids, continuations };
}

function collectShortsData(value, ids = new Set(), continuations = new Set()) {
  if (!value || typeof value !== 'object') return { ids, continuations };
  if (Array.isArray(value)) {
    for (const item of value) collectShortsData(item, ids, continuations);
    return { ids, continuations };
  }

  const shortsId =
    value.reelItemRenderer?.videoId ||
    value.shortsLockupViewModel?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ||
    (value.lockupViewModel?.contentType === 'LOCKUP_CONTENT_TYPE_SHORTS'
      ? value.lockupViewModel.contentId
      : null);
  if (/^[A-Za-z0-9_-]{11}$/.test(shortsId || '')) ids.add(shortsId);

  const continuationToken =
    value.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
    value.continuationItemRenderer?.continuationEndpoint?.command?.continuationCommand?.token ||
    value.nextContinuationData?.continuation;
  if (continuationToken) continuations.add(continuationToken);

  for (const child of Object.values(value)) collectShortsData(child, ids, continuations);
  return { ids, continuations };
}

function findShortsTabContent(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const content = findShortsTabContent(item);
      if (content) return content;
    }
    return null;
  }

  const tab = value.tabRenderer;
  if (tab?.title?.trim().toLowerCase() === 'shorts' && tab.content) return tab.content;

  for (const child of Object.values(value)) {
    const content = findShortsTabContent(child);
    if (content) return content;
  }
  return null;
}

async function fetchPlaylistContinuation(token, config) {
  if (!config?.INNERTUBE_API_KEY) {
    throw new Error('Could not read YouTube continuation API settings from the channel page.');
  }

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

async function fetchPlaylistVideoIds(playlistId, limit = Infinity) {
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

  while (queue.length && ids.size < limit) {
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
      if (ids.size >= limit) break;
    }

    for (const nextToken of nextContinuations) {
      if (!seenContinuations.has(nextToken)) {
        queue.push(nextToken);
      }
    }
  }

  return Array.from(ids).slice(0, limit);
}

async function resolveYoutubeChannelId(channel) {
  if (channel.channelId) return channel.channelId;
  const { data } = await axios.get(`${channel.url}/videos`, {
    timeout: PLAYLIST_FETCH_TIMEOUT_MS,
    headers: YOUTUBE_WEB_HEADERS,
  });
  const id = data.match(/(?:"externalId"|"browseId")\s*:\s*"(UC[A-Za-z0-9_-]{22})"/)?.[1];
  if (!id) throw new Error('Could not resolve that channel. Try its /channel/UC... link or channel ID.');
  return id;
}

async function fetchChannelVideoIds(channelId, limit = Infinity) {
  // YouTube's uploads playlist is the channel ID with its UC prefix changed to UU.
  return fetchPlaylistVideoIds(`UU${channelId.slice(2)}`, limit);
}

async function fetchChannelShortIds(channelId, limit = Infinity) {
  const { data } = await axios.get(`https://www.youtube.com/channel/${channelId}/shorts`, {
    timeout: PLAYLIST_FETCH_TIMEOUT_MS,
    headers: YOUTUBE_WEB_HEADERS,
  });
  const config = parseJsonAfter(data, 'ytcfg.set(');
  const initialData =
    parseJsonAfter(data, 'var ytInitialData =') ||
    parseJsonAfter(data, 'ytInitialData =');
  const shortsTabContent = findShortsTabContent(initialData);
  if (!shortsTabContent) {
    throw new Error('Could not find a Shorts tab for this channel.');
  }
  const ids = new Set();
  const continuations = new Set();
  collectShortsData(shortsTabContent, ids, continuations);

  const seenContinuations = new Set();
  const queue = Array.from(continuations);
  while (queue.length && ids.size < limit) {
    const token = queue.shift();
    if (seenContinuations.has(token)) continue;
    seenContinuations.add(token);

    const continuationData = await fetchPlaylistContinuation(token, config);
    if (!continuationData) continue;
    const nextIds = new Set();
    const nextContinuations = new Set();
    collectShortsData(continuationData, nextIds, nextContinuations);
    for (const id of nextIds) {
      ids.add(id);
      if (ids.size >= limit) break;
    }
    for (const nextToken of nextContinuations) {
      if (!seenContinuations.has(nextToken)) queue.push(nextToken);
    }
  }

  return Array.from(ids).slice(0, limit);
}

async function getSubscriptions(chatId) {
  const { data, error } = await supabase
    .from('youtube_channel_subscriptions')
    .select('channel_id, channel_url, status')
    .eq('chat_id', String(chatId))
    .eq('action', 'subscribe');
  if (error) throw error;
  return data || [];
}

async function saveSubscription(chatId, channelId, channelUrl, action) {
  const { error } = await supabase.from('youtube_channel_subscriptions').upsert({
    chat_id: String(chatId),
    channel_id: channelId,
    channel_url: channelUrl,
    action,
    status: 'pending',
  }, { onConflict: 'chat_id,channel_id' });
  if (error) throw error;
}

async function queueChannelVideos(channelId, channelUrl, videoIds) {
  if (!videoIds.length) return;
  await addQueueItems(videoIds.map((youtubeId) => ({
    youtube_id: youtubeId,
    original_input: channelUrl,
    status: 'pending',
  })));
}

async function addQueueItems(rows) {
  for (let offset = 0; offset < rows.length; offset += 500) {
    const { error } = await supabase
      .from('youtube_queue')
      .insert(rows.slice(offset, offset + 500));

    if (error) throw error;
  }
}

const pendingChannelCounts = new Map();

function channelDownloadOptions(channelId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'All videos', callback_data: `ch|va|${channelId}` },
          { text: 'All Shorts', callback_data: `ch|sa|${channelId}` },
        ],
        [
          { text: 'Number of videos', callback_data: `ch|vn|${channelId}` },
          { text: 'Number of Shorts', callback_data: `ch|sn|${channelId}` },
        ],
      ],
    },
  };
}

async function queueSelectedChannelItems(chatId, channelId, kind, limit = null) {
  const videoIds = kind === 'shorts'
    ? await fetchChannelShortIds(channelId, limit || Infinity)
    : await fetchChannelVideoIds(channelId, limit || Infinity);
  const selectedIds = limit ? videoIds.slice(0, limit) : videoIds;
  if (!selectedIds.length) {
    await bot.sendMessage(chatId, `⚠️ No ${kind === 'shorts' ? 'Shorts' : 'videos'} found for this channel.`);
    return;
  }

  const channelUrl = `https://www.youtube.com/channel/${channelId}`;
  await queueChannelVideos(channelId, channelUrl, selectedIds);
  await bot.sendMessage(chatId, `✅ Added ${selectedIds.length} ${kind === 'shorts' ? 'Shorts' : 'videos'} to the download queue.`);
}

bot.on('callback_query', async (query) => {
  const [prefix, choice, channelId] = (query.data || '').split('|');
  if (prefix !== 'ch' || !/^UC[A-Za-z0-9_-]{22}$/.test(channelId || '')) return;

  try {
    const chatId = query.message.chat.id;
    await bot.answerCallbackQuery(query.id);

    if (choice === 'vn' || choice === 'sn') {
      const kind = choice === 'sn' ? 'shorts' : 'videos';
      pendingChannelCounts.set(String(chatId), { channelId, kind });
      return bot.sendMessage(chatId, `How many ${kind === 'shorts' ? 'Shorts' : 'videos'} should I add? Send a positive whole number, or /cancel.`);
    }

    if (choice === 'va' || choice === 'sa') {
      return queueSelectedChannelItems(chatId, channelId, choice === 'sa' ? 'shorts' : 'videos');
    }
  } catch (e) {
    err('Channel download selection failed:', e.message);
    if (query.message?.chat?.id) {
      await bot.sendMessage(query.message.chat.id, `❌ Could not add channel downloads:\n${e.message}`);
    }
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (!text) return;

  if (/^\/cancel(?:@\w+)?$/i.test(text)) {
    const canceled = pendingChannelCounts.delete(String(chatId));
    return bot.sendMessage(chatId, canceled ? 'Cancelled the channel download request.' : 'There is no pending count request.');
  }

  const pendingCount = pendingChannelCounts.get(String(chatId));
  if (pendingCount) {
    if (!/^\d+$/.test(text) || Number(text) < 1 || !Number.isSafeInteger(Number(text))) {
      return bot.sendMessage(chatId, 'Send a positive whole number, or /cancel.');
    }
    pendingChannelCounts.delete(String(chatId));
    try {
      await queueSelectedChannelItems(chatId, pendingCount.channelId, pendingCount.kind, Number(text));
    } catch (e) {
      err('Limited channel download failed:', e.message);
      await bot.sendMessage(chatId, `❌ Could not add channel downloads:\n${e.message}`);
    }
    return;
  }

  if (text === '/start') {
    return bot.sendMessage(
      chatId,
      'Send a YouTube video or playlist to queue it. Send a channel link to choose videos or Shorts.\n' +
      'Commands: /subscribe <channel>, /unsubscribe <channel>, /subscriptions'
    );
  }

  const command = text.match(/^\/(subscribe|unsubscribe)(?:@\w+)?(?:\s+(.+))?$/i);
  if (command) {
    const channel = extractYoutubeChannel(command[2] || '');
    if (!channel) return bot.sendMessage(chatId, `Usage: /${command[1]} <YouTube channel URL or channel ID>`);
    try {
      const channelId = await resolveYoutubeChannelId(channel);
      if (command[1].toLowerCase() === 'unsubscribe') {
        await saveSubscription(chatId, channelId, channel.url, 'unsubscribe');
        return bot.sendMessage(chatId, `✅ Unsubscribe request for ${channelId} sent to TubeArchivist.`);
      }

      await saveSubscription(chatId, channelId, channel.url, 'subscribe');
      return bot.sendMessage(chatId, `✅ Subscribe request for ${channelId} sent to TubeArchivist.`);
    } catch (e) {
      err('Channel subscription failed:', e.message);
      return bot.sendMessage(chatId, `❌ Could not ${command[1].toLowerCase()} channel:\n${e.message}`);
    }
  }

  if (/^\/subscriptions(?:@\w+)?$/i.test(text)) {
    try {
      const subscriptions = await getSubscriptions(chatId);
      return bot.sendMessage(chatId, subscriptions.length
        ? `Subscribed channels:\n${subscriptions.map((item) => item.channel_url).join('\n')}`
        : 'You have no channel subscriptions.');
    } catch (e) {
      return bot.sendMessage(chatId, `❌ Could not load subscriptions:\n${e.message}`);
    }
  }

  if (/^\/(?:\w+)/.test(text)) return;

  const channel = extractYoutubeChannel(text);
  if (channel) {
    try {
      const channelId = await resolveYoutubeChannelId(channel);
      return bot.sendMessage(
        chatId,
        'What would you like to download from this channel?',
        channelDownloadOptions(channelId)
      );
    } catch (e) {
      err('Channel import failed:', e.message);
      return bot.sendMessage(chatId, `❌ Failed to import channel:\n${e.message}`);
    }
  }

  const playlistId = extractYoutubePlaylistId(text);

  if (playlistId) {
    try {
      const videoIds = await fetchPlaylistVideoIds(playlistId);
      const seedVideoId = extractYoutubePlaylistSeedId(text, playlistId);

      if (!videoIds.length && seedVideoId) {
        videoIds.push(seedVideoId);
      }

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
