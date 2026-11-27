require('dotenv').config();

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const {
  extractYoutubeId,
  extractYoutubePlaylistId,
  extractYoutubePlaylistSeedId,
  extractYoutubeChannel,
} = require('./utils/youtube');
const {
  fetchChannelVideoIds,
  fetchChannelShortIds,
  fetchPlaylistVideoIds,
  resolveYoutubeChannelId,
} = require('./utils/youtube-fetch');

const PORT = Number(process.env.WEB_CHAT_PORT || 4444);
const HOST = process.env.WEB_CHAT_HOST || '0.0.0.0';
const MAX_BODY_BYTES = 16 * 1024;
const pendingChannelCounts = new Map();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const publicDir = path.join(__dirname, 'public');
const tlsKey = process.env.WEB_CHAT_TLS_KEY;
const tlsCert = process.env.WEB_CHAT_TLS_CERT;

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:",
  });
  res.end(contentType.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error('Request is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON request.')); }
    });
    req.on('error', reject);
  });
}

function getLanAddresses() {
  const addresses = [];
  for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
    for (const info of interfaces || []) {
      if (info.family === 'IPv4' && !info.internal && !info.address.startsWith('169.254.')) {
        addresses.push({ interface: name, address: info.address });
      }
    }
  }
  return addresses;
}

function clientChatId(clientId) {
  if (typeof clientId !== 'string' || !/^[a-f0-9-]{36}$/i.test(clientId)) {
    throw new Error('Refresh the page and try again.');
  }
  return `web:${clientId}`;
}

async function resolveChannel(channel) {
  return resolveYoutubeChannelId(channel);
}

async function saveSubscription(chatId, channelId, channelUrl, action) {
  const { error } = await supabase.from('youtube_channel_subscriptions').upsert({
    chat_id: chatId,
    channel_id: channelId,
    channel_url: channelUrl,
    action,
    status: 'pending',
  }, { onConflict: 'chat_id,channel_id' });
  if (error) throw error;
}

async function addQueueItems(ids, originalInput) {
  const rows = ids.map((youtube_id) => ({ youtube_id, original_input: originalInput, status: 'pending' }));
  for (let offset = 0; offset < rows.length; offset += 500) {
    const { error } = await supabase.from('youtube_queue').insert(rows.slice(offset, offset + 500));
    if (error) throw error;
  }
}

async function queueSelectedChannelItems(channelId, kind, limit = null) {
  const ids = kind === 'shorts'
    ? await fetchChannelShortIds(channelId, limit || Infinity)
    : await fetchChannelVideoIds(channelId, limit || Infinity);
  const selectedIds = limit ? ids.slice(0, limit) : ids;
  if (!selectedIds.length) return `No ${kind === 'shorts' ? 'Shorts' : 'videos'} found for this channel.`;
  await addQueueItems(selectedIds, `https://www.youtube.com/channel/${channelId}`);
  return `✅ Added ${selectedIds.length} ${kind === 'shorts' ? 'Shorts' : 'videos'} to the download queue.`;
}

function channelChoices(channelId, channelUrl) {
  return [
    { label: 'Subscribe', message: `/subscribe ${channelUrl}` },
    { label: 'Unsubscribe', message: `/unsubscribe ${channelUrl}` },
    { label: 'Download all videos', message: `/download_videos_all ${channelId}` },
    { label: 'Download all Shorts', message: `/download_shorts_all ${channelId}` },
    { label: 'Download a number of videos', message: `/download_videos_count ${channelId}` },
    { label: 'Download a number of Shorts', message: `/download_shorts_count ${channelId}` },
  ];
}

const HELP = `Hi! I can queue YouTube downloads and manage channel subscriptions.\n\nCommands:\n/help — show this guide\n/subscribe <channel URL or ID> — subscribe\n/unsubscribe <channel URL or ID> — unsubscribe\n/subscriptions — list subscriptions\n/cancel — cancel a limited channel download prompt\n\nSend a YouTube video link or ID to queue it, a playlist link to queue its videos, or a channel link to choose subscription and download options.`;

async function handleChat(text, clientId) {
  const chatId = clientChatId(clientId);
  const input = String(text || '').trim();
  if (!input) throw new Error('Type a message first.');
  if (input.length > 2000) throw new Error('Please keep messages under 2,000 characters.');

  const pendingCount = pendingChannelCounts.get(clientId);
  if (pendingCount && /^\d+$/.test(input)) {
    const count = Number(input);
    if (!Number.isSafeInteger(count) || count < 1) return 'Send a positive whole number, or /cancel.';
    pendingChannelCounts.delete(clientId);
    return queueSelectedChannelItems(pendingCount.channelId, pendingCount.kind, count);
  }

  const command = input.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]+))?$/);
  if (pendingCount && !command) return 'Send a positive whole number, or /cancel.';
  if (command) {
    const name = command[1].toLowerCase();
    const arg = command[2]?.trim() || '';
    if (name === 'start' || name === 'help') return HELP;
    if (name === 'cancel') {
      const canceled = pendingChannelCounts.delete(clientId);
      return canceled ? 'Cancelled the limited channel download.' : 'There is no pending request to cancel.';
    }
    const download = name.match(/^download_(videos|shorts)_(all|count)$/);
    if (download) {
      if (!/^UC[A-Za-z0-9_-]{22}$/.test(arg)) return 'That channel ID is invalid. Send the channel link again.';
      const kind = download[1] === 'shorts' ? 'shorts' : 'videos';
      if (download[2] === 'count') {
        pendingChannelCounts.set(clientId, { channelId: arg, kind });
        return `How many ${kind === 'shorts' ? 'Shorts' : 'videos'} should I add? Enter a positive whole number, or /cancel.`;
      }
      return queueSelectedChannelItems(arg, kind);
    }
    if (name === 'subscribe' || name === 'unsubscribe') {
      const channel = extractYoutubeChannel(arg);
      if (!channel) return `Usage: /${name} <YouTube channel URL or channel ID>`;
      const channelId = await resolveChannel(channel);
      await saveSubscription(chatId, channelId, channel.url, name);
      return `✅ ${name === 'subscribe' ? 'Subscribe' : 'Unsubscribe'} request for ${channelId} sent to TubeArchivist.`;
    }
    if (name === 'subscriptions') {
      const { data, error } = await supabase.from('youtube_channel_subscriptions')
        .select('channel_url,status').eq('chat_id', chatId).eq('action', 'subscribe');
      if (error) throw error;
      return data?.length ? `Subscribed channels:\n${data.map((row) => `${row.channel_url} (${row.status})`).join('\n')}` : 'You have no channel subscriptions.';
    }
    return `Unknown command: /${name}. Send /help to see available commands.`;
  }

  const playlistId = extractYoutubePlaylistId(input);
  if (playlistId) {
    const ids = await fetchPlaylistVideoIds(playlistId);
    const seedId = extractYoutubePlaylistSeedId(input, playlistId);
    if (seedId && !ids.includes(seedId)) ids.unshift(seedId);
    if (!ids.length) return 'I found the playlist, but could not read any videos from it.';
    await addQueueItems(ids, input);
    if (playlistId.startsWith('RD') && ids.length === 1) {
      return `✅ Added the Mix seed video (${seedId}) to the download queue. YouTube did not expose the rest of this Mix.`;
    }
    return `✅ Added ${ids.length} ${playlistId.startsWith('RD') ? 'Mix videos' : 'playlist videos'} to the download queue.`;
  }

  const channel = extractYoutubeChannel(input);
  if (channel) {
    const channelId = await resolveChannel(channel);
    const channelUrl = channel.channelId ? channel.url : `https://www.youtube.com/channel/${channelId}`;
    return {
      reply: 'What would you like to do with this channel?',
      choices: channelChoices(channelId, channelUrl),
    };
  }

  const videoId = extractYoutubeId(input);
  if (!videoId) return 'I could not find a YouTube video, playlist, or command. Send /help for examples.';
  await addQueueItems([videoId], input);
  return `✅ Added to queue: ${videoId}`;
}

async function route(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && pathname === '/') {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    return send(res, 200, html, 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && pathname === '/app.js') {
    const script = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
    return send(res, 200, script, 'text/javascript; charset=utf-8');
  }
  if (req.method === 'GET' && pathname === '/api/info') {
    const scheme = tlsKey && tlsCert ? 'https' : 'http';
    return send(res, 200, {
      scheme,
      port: PORT,
      addresses: getLanAddresses(),
    });
  }
  if (req.method === 'POST' && pathname === '/api/chat') {
    const body = await readJson(req);
    try {
      const result = await handleChat(body.message, body.clientId);
      return send(res, 200, typeof result === 'string' ? { reply: result } : result);
    } catch (e) {
      if (e.isAxiosError) {
        const status = e.response?.status || 'network error';
        const detail = e.response?.data?.error?.message || e.message;
        console.error(`YouTube request failed (${status}):`, detail);
        return send(res, 502, { error: 'YouTube could not load this playlist right now. Please try again.' });
      }
      console.error('Web chat action failed:', e.message || e);
      return send(res, 400, { error: e.message || 'The request failed.' });
    }
  }
  return send(res, 404, { error: 'Not found.' });
}

const handler = (req, res) => route(req, res).catch((e) => {
  console.error('Local chat request failed:', e.message);
  if (!res.headersSent) send(res, 500, { error: 'The server could not complete that request.' });
});

let server;
if (tlsKey || tlsCert) {
  if (!tlsKey || !tlsCert) throw new Error('Set both WEB_CHAT_TLS_KEY and WEB_CHAT_TLS_CERT to enable HTTPS.');
  server = https.createServer({ key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert) }, handler);
} else {
  server = http.createServer(handler);
}
server.listen(PORT, HOST, () => {
  const scheme = tlsKey && tlsCert ? 'https' : 'http';
  console.log(`Local chat listening at ${scheme}://${HOST}:${PORT}`);
  const addresses = getLanAddresses();
  if (addresses.length) {
    for (const { interface: name, address } of addresses) {
      console.log(`Chat URL (${name}): ${scheme}://${address}:${PORT}`);
    }
  } else {
    console.log(`No LAN IPv4 address found. Try ${scheme}://localhost:${PORT}`);
  }
  if (scheme === 'http' && HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn('LAN traffic is not encrypted. Configure a TLS certificate with WEB_CHAT_TLS_KEY and WEB_CHAT_TLS_CERT for HTTPS.');
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
