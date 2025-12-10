#!/bin/sh
if [ -n "$TELEGRAM_API_ID" ] && [ -n "$TELEGRAM_API_HASH" ]; then
  echo "Starting local Telegram Bot API server..."
  echo "API ID: ${TELEGRAM_API_ID}"
  echo "API Hash: ${TELEGRAM_API_HASH:0:10}..."
  
  # Запускаем сервер в фоне с логированием
  telegram-bot-api --local --api-id=${TELEGRAM_API_ID} --api-hash=${TELEGRAM_API_HASH} --http-port=8081 > /tmp/telegram-bot-api.log 2>&1 &
  TELEGRAM_API_PID=$!
  echo "Telegram Bot API server PID: $TELEGRAM_API_PID"
  
  # Даем серверу больше времени на запуск (15 секунд)
  echo "Waiting for local Telegram Bot API server to start (15 seconds)..."
  sleep 15
  
  # Проверяем, что процесс еще работает
  if kill -0 $TELEGRAM_API_PID 2>/dev/null; then
    echo "Local Telegram Bot API server process is running"
    echo "Server logs (last 20 lines):"
    tail -20 /tmp/telegram-bot-api.log 2>/dev/null || echo "No logs available yet"
    export USE_LOCAL_API=true
    export LOCAL_API_URL=http://localhost:8081
  else
    echo "ERROR: Local Telegram Bot API server process died. Logs:"
    cat /tmp/telegram-bot-api.log 2>/dev/null || echo "No logs available"
    echo "Falling back to standard Telegram Bot API"
    export USE_LOCAL_API=false
  fi
else
  echo "TELEGRAM_API_ID or TELEGRAM_API_HASH not set, using standard Telegram Bot API"
  export USE_LOCAL_API=false
fi

echo "Starting bot..."
echo "USE_LOCAL_API=${USE_LOCAL_API}"
echo "LOCAL_API_URL=${LOCAL_API_URL}"
cd /app/bot
npx tsx server.ts

