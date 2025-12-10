# Multi-stage build для telegram-bot-api
FROM ubuntu:22.04 AS telegram-bot-api-builder

RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    cmake \
    gperf \
    libssl-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

RUN git clone https://github.com/tdlib/telegram-bot-api.git && \
    cd telegram-bot-api && \
    git submodule init && \
    git submodule update && \
    mkdir build && \
    cd build && \
    cmake .. && \
    cmake --build . -j$(nproc)

# Финальный образ
FROM node:20-alpine

# Устанавливаем зависимости для telegram-bot-api
RUN apk add --no-cache libstdc++ libgcc

# Копируем telegram-bot-api из builder
COPY --from=telegram-bot-api-builder /build/telegram-bot-api/build/telegram-bot-api /usr/local/bin/telegram-bot-api
RUN chmod +x /usr/local/bin/telegram-bot-api

WORKDIR /app

# Устанавливаем зависимости бота
COPY bot/package*.json ./bot/
RUN cd bot && npm install --production=false

# Копируем весь проект
COPY . .

WORKDIR /app/bot

# Скрипт запуска: сначала telegram-bot-api, потом бот
RUN echo '#!/bin/sh\n\
if [ -n "$TELEGRAM_API_ID" ] && [ -n "$TELEGRAM_API_HASH" ]; then\n\
  echo "Starting local Telegram Bot API server..."\n\
  telegram-bot-api --local --api-id=${TELEGRAM_API_ID} --api-hash=${TELEGRAM_API_HASH} --http-port=8081 &\n\
  sleep 3\n\
  export USE_LOCAL_API=true\n\
  export LOCAL_API_URL=http://localhost:8081\n\
fi\n\
echo "Starting bot..."\n\
npx tsx server.ts\n\
' > /app/start.sh && chmod +x /app/start.sh

CMD ["/app/start.sh"]
