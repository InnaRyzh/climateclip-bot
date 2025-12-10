#!/bin/sh
if [ -n "$TELEGRAM_API_ID" ] && [ -n "$TELEGRAM_API_HASH" ]; then
  echo "Starting local Telegram Bot API server..."
  telegram-bot-api --local --api-id=${TELEGRAM_API_ID} --api-hash=${TELEGRAM_API_HASH} --http-port=8081 &
  sleep 3
  export USE_LOCAL_API=true
  export LOCAL_API_URL=http://localhost:8081
fi
echo "Starting bot..."
cd /app/bot
npx tsx server.ts

