require('dotenv').config();

const { spawn } = require('child_process');
require('./local-chat-server');

if (process.env.TELEGRAM_TOKEN) {
  const bot = spawn(process.execPath, [require.resolve('./bot')], { stdio: 'inherit' });
  bot.on('error', (e) => console.error('Could not start Telegram bot:', e.message));
  bot.on('exit', (code, signal) => {
    if (signal) console.log(`Telegram bot stopped (${signal}).`);
    else if (code) console.error(`Telegram bot exited with code ${code}.`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => bot.kill(signal));
  }
} else {
  console.log('TELEGRAM_TOKEN is unset; starting local web chat only.');
}
