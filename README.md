# YouTube Telegram Bot

A simple Telegram bot that listens for YouTube links, playlists, or video IDs in chat and triggers a download through your Tube API server.
Built with **Node.js**, **node-telegram-bot-api**, and **Axios**.  
Runs inside **Docker** on Raspberry Pi 5 (ARM64) or any Linux host.

---

## ✨ Features
- Accepts full YouTube URLs, playlist URLs, shorts, live, embed links, or raw 11-character video IDs.
- Validates and extracts the correct YouTube video ID.
- Extracts all video IDs from YouTube playlists and queues each one.
- Accepts channel URLs or channel IDs and queues uploaded videos.
- Supports persistent per-chat subscriptions that queue new uploads automatically.
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
CHANNEL_POLL_INTERVAL_MS=900000
```

`CHANNEL_POLL_INTERVAL_MS` is optional (default 15 minutes, minimum 1 minute). Keep the Supabase service role key private.

## Channel commands

- Send a channel URL or `UC...` channel ID to queue all currently available uploads.
- `/subscribe <channel URL or ID>` queues current uploads and subscribes the current Telegram chat to future uploads.
- `/unsubscribe <channel URL or ID>` removes that chat's subscription.
- `/subscriptions` lists the current chat's subscriptions.

Create this table in Supabase before using subscriptions:

```sql
create table if not exists public.youtube_channel_subscriptions (
  chat_id text not null,
  channel_id text not null,
  channel_url text not null,
  last_seen_video_id text,
  created_at timestamptz not null default now(),
  primary key (chat_id, channel_id)
);
```
