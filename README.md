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

- Send a channel URL or `UC...` channel ID to queue all currently available uploads.
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
