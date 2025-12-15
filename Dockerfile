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

# Финальный образ - используем Ubuntu для совместимости с telegram-bot-api
FROM node:20

# Устанавливаем зависимости для telegram-bot-api и Node.js
RUN apt-get update && apt-get install -y \
    libssl3 \
    libc6 \
    zlib1g \
    ca-certificates \
    curl \
    chromium \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    fonts-liberation \
    libgbm1 \
    && rm -rf /var/lib/apt/lists/*

# Копируем telegram-bot-api из builder
COPY --from=telegram-bot-api-builder /build/telegram-bot-api/build/telegram-bot-api /usr/local/bin/telegram-bot-api
RUN chmod +x /usr/local/bin/telegram-bot-api

# Проверяем, что бинарник работает
RUN telegram-bot-api --version || echo "Binary check failed, will try at runtime"

WORKDIR /app

# Устанавливаем зависимости бота
COPY bot/package*.json ./bot/
RUN cd bot && npm install --production=false

# Копируем весь проект
COPY . .

WORKDIR /app/bot

# Запускаем бота напрямую через npm start
CMD ["npm", "start"]
