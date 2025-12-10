#!/bin/bash
set -e

echo "=== Starting ClimateClip Bot ==="
echo "Node version: $(node --version)"
echo "Working directory: $(pwd)"

# Проверяем наличие telegram-bot-api
if ! command -v telegram-bot-api &> /dev/null; then
  echo "WARNING: telegram-bot-api not found in PATH"
  echo "Trying /usr/local/bin/telegram-bot-api..."
  if [ ! -f /usr/local/bin/telegram-bot-api ]; then
    echo "ERROR: telegram-bot-api binary not found!"
    export USE_LOCAL_API=false
  else
    export PATH="/usr/local/bin:$PATH"
  fi
fi

if [ -n "$TELEGRAM_API_ID" ] && [ -n "$TELEGRAM_API_HASH" ]; then
  echo "=== Starting local Telegram Bot API server ==="
  echo "API ID: ${TELEGRAM_API_ID}"
  echo "API Hash: ${TELEGRAM_API_HASH:0:10}..."
  
  # Создаем директорию для данных сервера
  mkdir -p /tmp/telegram-bot-api-data
  
  # Запускаем сервер в фоне с логированием
  telegram-bot-api \
    --local \
    --api-id=${TELEGRAM_API_ID} \
    --api-hash=${TELEGRAM_API_HASH} \
    --http-port=8081 \
    --local-database-path=/tmp/telegram-bot-api-data \
    > /tmp/telegram-bot-api.log 2>&1 &
  
  TELEGRAM_API_PID=$!
  echo "Telegram Bot API server PID: $TELEGRAM_API_PID"
  
  # Ждем запуска сервера (проверяем каждую секунду)
  echo "Waiting for local Telegram Bot API server to start..."
  for i in {1..30}; do
    sleep 1
    if kill -0 $TELEGRAM_API_PID 2>/dev/null; then
      # Проверяем, отвечает ли сервер
      if curl -s http://localhost:8081/bot${BOT_TOKEN}/getMe > /dev/null 2>&1; then
        echo "✅ Local Telegram Bot API server is ready!"
        echo "Server logs (last 10 lines):"
        tail -10 /tmp/telegram-bot-api.log 2>/dev/null || echo "No logs yet"
        export USE_LOCAL_API=true
        export LOCAL_API_URL=http://localhost:8081
        break
      fi
    else
      echo "❌ ERROR: Local Telegram Bot API server process died!"
      echo "Server logs:"
      cat /tmp/telegram-bot-api.log 2>/dev/null || echo "No logs available"
      echo "Falling back to standard Telegram Bot API"
      export USE_LOCAL_API=false
      break
    fi
    
    if [ $i -eq 30 ]; then
      echo "⚠️ WARNING: Server didn't respond after 30 seconds"
      echo "Server logs:"
      tail -20 /tmp/telegram-bot-api.log 2>/dev/null || echo "No logs available"
      echo "Will try to use it anyway..."
      export USE_LOCAL_API=true
      export LOCAL_API_URL=http://localhost:8081
    fi
  done
else
  echo "TELEGRAM_API_ID or TELEGRAM_API_HASH not set"
  echo "Using standard Telegram Bot API (20MB limit for downloads)"
  export USE_LOCAL_API=false
fi

echo ""
echo "=== Starting bot ==="
echo "USE_LOCAL_API=${USE_LOCAL_API}"
echo "LOCAL_API_URL=${LOCAL_API_URL}"
cd /app/bot
exec npx tsx server.ts

