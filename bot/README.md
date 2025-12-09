# ClimateClip Telegram Bot

Telegram-бот для автоматического создания климатических видео.

## Установка

1. Установите зависимости:
```bash
cd bot
npm install
```

2. Создайте файл `.env`:
```bash
cp .env.example .env
```

3. Добавьте токен бота в `.env`:
```
BOT_TOKEN=your_bot_token_here
```

## Запуск локально

```bash
npm run dev
```

## Деплой на Railway

1. Создайте проект на Railway
2. Подключите репозиторий
3. Добавьте переменную окружения `BOT_TOKEN`
4. Railway автоматически определит настройки из `railway.json`

## Использование

1. Отправьте `/start` боту
2. Выберите шаблон (Grid 4x или News)
3. Следуйте инструкциям бота

## Требования

- Node.js 18+
- FFmpeg (для обработки видео)
- Puppeteer (для рендеринга)

## Структура

- `server.ts` - основной сервер и логика бота
- `videoRenderer.ts` - рендеринг видео
- `fileManager.ts` - управление файлами
- `compositorAdapter.ts` - адаптер для существующей логики рендеринга


