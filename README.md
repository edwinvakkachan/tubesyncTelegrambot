# YouTube Telegram Bot

A simple Telegram bot that listens for YouTube links or video IDs in chat and triggers a download through your Tube API server.  
Built with **Node.js**, **node-telegram-bot-api**, and **Axios**.  
Runs inside **Docker** on Raspberry Pi 5 (ARM64) or any Linux host.

---

## ✨ Features
- Accepts full YouTube URLs, shorts, live, embed links, or raw 11-character video IDs.
- Validates and extracts the correct YouTube video ID.
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
API_TOKEN=your_tube_api_token_here
TUBE_API_URL=https://youtube.wreath.blog:13870/api/download/?autostart=true
