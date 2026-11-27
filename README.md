# YouTube Telegram Bot

A simple Telegram bot that listens for YouTube links, playlists, or video IDs in chat and triggers a download through your Tube API server.
Built with **Node.js**, **node-telegram-bot-api**, and **Axios**.  
Runs inside **Docker** on Raspberry Pi 5 (ARM64) or any Linux host.

## Local web chat

The same bot can be used from a browser at `http://<server-LAN-IP>:4444`, including when the Telegram app is unavailable. It supports video links, playlist links, channel actions, and the subscription commands below. Sending a channel link offers Subscribe, Unsubscribe, Download all videos, Download all Shorts, or a limited number of videos or Shorts. Web chat subscriptions are kept separate per browser from Telegram chat subscriptions. The server discovers its active LAN IPv4 addresses at startup and displays them in the terminal and chat header; they can change when the server moves networks.

1. Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. `TELEGRAM_TOKEN` is optional if you only need web chat.
2. Start the service with `npm start` or `docker compose up -d --build`.
3. Open one of the LAN URLs printed at startup, or shown in the chat header, on a device connected to the same network. No sign-in is required.

The default is HTTP. To enable HTTPS, place a certificate and private key in the local `certs` folder (for Docker), then set `WEB_CHAT_TLS_CERT=/certs/fullchain.pem` and `WEB_CHAT_TLS_KEY=/certs/privkey.pem`. Open `https://<server-LAN-IP>:4444`; the certificate must be trusted by the device/browser. For a trusted certificate, use a hostname covered by that certificate.

The chat has no password because it is intended for your trusted local network. Anyone who can reach the server can add downloads and change web chat subscriptions. Use HTTPS certificates for encrypted LAN traffic when needed.

---

## ✨ Features
- Accepts full YouTube URLs, playlist URLs, shorts, live, embed links, or raw 11-character video IDs.
- Validates and extracts the correct YouTube video ID.
- Extracts all video IDs from YouTube playlists and queues each one.
- Recognizes YouTube Mix URLs (`list=RD...`), reads the Mix from its watch page, and keeps the seed video in the queue if Mix entries are unavailable.
- Shows channel download options for all videos, all Shorts, or a custom number of either.
- Stores per-chat channel subscriptions in Supabase for TubeArchivist to process.
- Calls your Tube API with `youtube_id` and marks status as `pending`.
- Replies in Telegram with ✅ success or ❌ error messages.
- Dockerized for easy deployment on Raspberry Pi.

---

## 📦 Requirements
- Telegram bot token (create via [@BotFather](https://t.me/BotFather))
- Tube API token + URL
- Docker + Compose installed on your Raspberry Pi (or Linux server)

---

## 🔑 Environment Variables
Create a `.env` file in the project root (never commit it).  

```env
TELEGRAM_TOKEN=your_telegram_bot_token_here
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

Keep the Supabase service role key private.

## Channel commands

The bot publishes these commands in Telegram's command menu when it starts:

- `/start` and `/help` show the bot's usage guide.
- `/cancel` cancels a pending request for a number of channel videos or Shorts.
- `/subscribe <channel URL or ID>` and `/unsubscribe <channel URL or ID>` request subscription changes.
- `/subscriptions` lists the current chat's subscriptions.

- Send a channel URL or `UC...` channel ID to choose all videos, all Shorts, a number of videos, or a number of Shorts. For a numbered option, send the desired count after selecting it.
- `/subscribe <channel URL or ID>` writes an `action = subscribe`, `status = pending` request to Supabase without queueing videos.
- `/unsubscribe <channel URL or ID>` writes an `action = unsubscribe`, `status = pending` request. The row stays available for TubeArchivist to process and update.
- `/subscriptions` lists the current chat's subscriptions.

Create this table in Supabase before using subscriptions:

```sql
create table if not exists public.youtube_channel_subscriptions (
  chat_id text not null,
  channel_id text not null,
  channel_url text not null,
  action text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  primary key (chat_id, channel_id)
);
```

For an existing table, migrate it with:

```sql
alter table public.youtube_channel_subscriptions
  add column if not exists action text not null default 'subscribe',
  add column if not exists status text not null default 'pending';

alter table public.youtube_channel_subscriptions
  drop column if exists last_seen_video_id;
```

TubeArchivist should update `status` after it processes each row. Suggested values are `pending`, `processed`, and `failed`.
