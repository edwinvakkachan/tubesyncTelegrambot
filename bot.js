require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const { fetchPlaylistVideoIds, resolveYoutubeChannelId, fetchChannelVideoIds, fetchChannelShortIds } = require("./utils/youtube-fetch");
const {
  extractYoutubeId,
  extractYoutubePlaylistId,
  extractYoutubePlaylistSeedId,
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

const BOT_COMMANDS = [
  { command: 'start', description: 'Start the bot and see what it can do' },
  { command: 'help', description: 'Show commands and usage examples' },
  { command: 'subscribe', description: 'Subscribe to a YouTube channel' },
  { command: 'unsubscribe', description: 'Unsubscribe from a YouTube channel' },
  { command: 'subscriptions', description: 'List your subscribed channels' },
  { command: 'cancel', description: 'Cancel a channel download prompt' },
];

bot.setMyCommands(BOT_COMMANDS).catch((e) => {
  warn('Could not publish Telegram command menu:', e?.message || e);
});

bot.on('polling_error', (e) => err('Polling error:', e?.message || e));

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

const HELP_TEXT = [
  'YouTube Download Bot',
  '',
  'Send a YouTube video link or 11-character video ID to add it to the download queue.',
  'Send a playlist link to queue its videos. Send a channel link to choose videos or Shorts.',
  '',
  'Commands:',
  '/start — start the bot',
  '/help — show this help',
  '/subscribe <channel URL or ID> — subscribe to a channel',
  '/unsubscribe <channel URL or ID> — unsubscribe from a channel',
  '/subscriptions — list your channel subscriptions',
  '/cancel — cancel a pending count prompt',
  '',
  'Examples:',
  '/subscribe https://www.youtube.com/@Google',
  '/unsubscribe UCxxxxxxxxxxxxxxxxxxxxxx',
].join('\n');

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

  if (/^\/cancel(?:@\w+)?(?:\s|$)/i.test(text)) {
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

  if (/^\/(?:start|help)(?:@\w+)?(?:\s|$)/i.test(text)) {
    return bot.sendMessage(chatId, HELP_TEXT);
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

  if (/^\/subscriptions(?:@\w+)?(?:\s|$)/i.test(text)) {
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
