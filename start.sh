#!/bin/bash

# Запускаем telegram-bot-api сервер в фоне, если USE_LOCAL_API=true
if [ "$USE_LOCAL_API" = "true" ]; then
    echo "Starting local Telegram Bot API server..."
    telegram-bot-api --local &
    API_PID=$!
    echo "Telegram Bot API server started with PID: $API_PID"
    # Ждём немного, чтобы сервер успел запуститься
    sleep 3
fi

# Запускаем бота
cd /app/bot
exec npm start

