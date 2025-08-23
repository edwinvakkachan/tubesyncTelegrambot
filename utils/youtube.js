// utils/youtube.js
function extractYoutubeId(text = "") {
  const input = String(text).trim();

  // Try to find a URL inside a longer message
  const urlMatch = input.match(/https?:\/\/[^\s]+/);
  const candidate = urlMatch ? urlMatch[0] : input;

  try {
    // If it's a URL, use URL parsing
    const u = new URL(candidate);

    // youtube domains (incl. m.)
    const host = u.hostname.replace(/^www\./, "");
    const isYouTube =
      host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be" || host === "music.youtube.com";

    if (isYouTube) {
      // 1) Standard: https://www.youtube.com/watch?v=VIDEOID
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;

      // 2) youtu.be/VIDEOID
      // 3) /shorts/VIDEOID
      // 4) /live/VIDEOID
      // 5) /embed/VIDEOID
      // 6) /v/VIDEOID (legacy)
      const seg = u.pathname.split("/").filter(Boolean);
      const candidates = [
        seg[0] === "shorts" && seg[1],
        seg[0] === "live" && seg[1],
        seg[0] === "embed" && seg[1],
        seg[0] === "v" && seg[1],
        host === "youtu.be" && seg[0],
      ].filter(Boolean);

      for (const id of candidates) {
        if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
      }

      // Sometimes links carry ?si=... or other params after the ID in path—strip non‑ID tail
      if (seg.length) {
        const maybe = seg[seg.length - 1].slice(0, 11);
        if (/^[A-Za-z0-9_-]{11}$/.test(maybe)) return maybe;
      }
    }
  } catch {
    // Not a URL — continue to raw checks
  }

  // 7) Bare 11-char ID in message
  const raw = candidate.match(/\b([A-Za-z0-9_-]{11})\b/);
  return raw ? raw[1] : null;
}

module.exports = { extractYoutubeId };
