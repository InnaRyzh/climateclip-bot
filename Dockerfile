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

# Копируем скрипт запуска
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

WORKDIR /app/bot

CMD ["/app/start.sh"]
