# Инструкция по настройке Telegram-бота

## Шаг 1: Создание бота в Telegram

1. Откройте [@BotFather](https://t.me/BotFather) в Telegram
2. Отправьте `/newbot`
3. Следуйте инструкциям для создания бота
4. Сохраните токен бота (например: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

## Шаг 2: Установка зависимостей

```bash
cd bot
npm install
```

## Шаг 3: Настройка переменных окружения

Создайте файл `.env` в папке `bot/`:

```env
BOT_TOKEN=ваш_токен_бота
PORT=3000
```

## Шаг 4: Установка FFmpeg (для обработки видео)

### macOS:
```bash
brew install ffmpeg
```

### Linux (Ubuntu/Debian):
```bash
sudo apt-get update
sudo apt-get install ffmpeg
```

### Windows:
Скачайте с [ffmpeg.org](https://ffmpeg.org/download.html) и добавьте в PATH

## Шаг 5: Запуск локально

```bash
npm run dev
```

Бот должен ответить на `/start` в Telegram.

## Шаг 6: Деплой на Railway

1. Зарегистрируйтесь на [Railway.app](https://railway.app)
2. Создайте новый проект
3. Подключите ваш GitHub репозиторий
4. Добавьте переменную окружения:
   - `BOT_TOKEN` = ваш токен бота
5. Railway автоматически определит настройки из `railway.json`
6. Дождитесь деплоя

## Использование бота

1. Отправьте `/start` боту
2. Выберите шаблон:
   - **Шаблон 1 (Grid 4x)**: Отправьте 4 видео, затем страны и дату
   - **Шаблон 2 (News)**: Отправьте 5 видео, затем страну, дату и описание
3. Дождитесь готового видео

## Структура проекта

- `server.ts` - основной сервер и логика бота
- `videoRenderer.ts` - рендеринг видео через Puppeteer
- `fileManager.ts` - управление файлами
- `compositorAdapter.ts` - адаптер для существующей логики

## Требования

- Node.js 18+
- FFmpeg
- Puppeteer (устанавливается автоматически)
- Минимум 2GB RAM для рендеринга видео


