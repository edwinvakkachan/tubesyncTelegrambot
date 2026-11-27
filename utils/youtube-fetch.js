const axios = require("axios");
const { extractVideoIdsFromPlaylistHtml } = require("./youtube");
const PLAYLIST_FETCH_TIMEOUT_MS = 15000;
const YOUTUBE_WEB_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

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

  const playlistVideoId =
    value.playlistVideoRenderer?.videoId ||
    value.playlistPanelVideoRenderer?.videoId;
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

function findMixPlaylistData(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMixPlaylistData(item);
      if (found) return found;
    }
    return null;
  }

  if (value.playlistPanelRenderer) return value.playlistPanelRenderer;
  const playlist = value.playlist;
  if (Array.isArray(playlist?.contents) && playlist.contents.some((item) =>
    item?.playlistPanelVideoRenderer || item?.continuationItemRenderer
  )) {
    return playlist;
  }

  for (const child of Object.values(value)) {
    const found = findMixPlaylistData(child);
    if (found) return found;
  }
  return null;
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

async function fetchPlaylistContinuation(token, config, options = {}) {
  if (!config?.INNERTUBE_API_KEY) {
    throw new Error('Could not read YouTube continuation API settings from the channel page.');
  }

  const context = config.INNERTUBE_CONTEXT || {
    client: {
      clientName: 'WEB',
      clientVersion: config.INNERTUBE_CLIENT_VERSION || '2.20240101.00.00',
    },
  };

  const endpoint = options.endpoint || 'browse';
  const requestBody = { context, continuation: token };
  if (options.videoId) requestBody.videoId = options.videoId;
  if (options.playlistId) requestBody.playlistId = options.playlistId;

  const { data } = await axios.post(
    `https://www.youtube.com/youtubei/v1/${endpoint}?key=${encodeURIComponent(config.INNERTUBE_API_KEY)}`,
    requestBody,
    {
      timeout: PLAYLIST_FETCH_TIMEOUT_MS,
      headers: YOUTUBE_WEB_HEADERS,
    }
  );

  return data;
}

async function fetchPlaylistVideoIds(playlistId, limit = Infinity) {
  const isMix = playlistId.startsWith('RD');
  const mixSeedId = isMix ? playlistId.slice(2, 13) : null;
  const validMixSeed = /^[A-Za-z0-9_-]{11}$/.test(mixSeedId || '') ? mixSeedId : null;
  const url = validMixSeed
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(validMixSeed)}&list=${encodeURIComponent(playlistId)}`
    : `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
  let data;
  try {
    ({ data } = await axios.get(url, {
      timeout: PLAYLIST_FETCH_TIMEOUT_MS,
      headers: YOUTUBE_WEB_HEADERS,
    }));
  } catch (error) {
    if (validMixSeed) return [validMixSeed].slice(0, limit);
    throw error;
  }

  const config = parseJsonAfter(data, 'ytcfg.set(');
  const initialData =
    parseJsonAfter(data, 'var ytInitialData =') ||
    parseJsonAfter(data, 'ytInitialData =');

  const ids = new Set(validMixSeed ? [validMixSeed] : []);
  const continuations = new Set();

  if (initialData) {
    const playlistData = isMix ? findMixPlaylistData(initialData) : initialData;
    if (playlistData) collectPlaylistData(playlistData, ids, continuations);
  }

  if (!ids.size && !isMix) {
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
    const continuationData = await fetchPlaylistContinuation(token, config, isMix
      ? { endpoint: 'next', videoId: validMixSeed, playlistId }
      : undefined);
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

module.exports = { parseJsonAfter, collectPlaylistData, findMixPlaylistData, collectShortsData, findShortsTabContent, fetchPlaylistContinuation, fetchPlaylistVideoIds, resolveYoutubeChannelId, fetchChannelVideoIds, fetchChannelShortIds };
