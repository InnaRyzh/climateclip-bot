FROM node:20-alpine

WORKDIR /app

# Устанавливаем зависимости бота
COPY bot/package*.json ./bot/
RUN cd bot && npm install --production=false

# Копируем весь проект
COPY . .

WORKDIR /app/bot

# Запуск бота
CMD ["npx", "tsx", "server.ts"]

