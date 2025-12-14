import express from 'express';
import { config } from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import { renderVideo } from './videoRenderer.js';
import { convertWebmToMp4, addAudioToVideo } from './videoConverter.js';
import { downloadFile, cleanupFiles, trimVideoToDuration } from './fileManager.js';
import { rewriteNewsText } from './aiService.js';
import { generateNewsAudioTrack } from './elevenLabsService.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

config();

console.log('=== Starting ClimateClip Bot ===');
console.log('Node version:', process.version);
console.log('Working directory:', process.cwd());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

console.log('PORT:', PORT);
console.log('BOT_TOKEN:', BOT_TOKEN ? 'SET' : 'MISSING');
console.log('PERPLEXITY_API_KEY:', PERPLEXITY_API_KEY ? 'SET' : 'MISSING');

if (!BOT_TOKEN) {
  console.error('Ошибка: BOT_TOKEN не найден в .env');
  process.exit(1);
}

if (!PERPLEXITY_API_KEY) {
  console.warn('Внимание: PERPLEXITY_API_KEY не найден. Используется алгоритмический фолбэк без AI.');
}

// Проверяем, есть ли локальный Telegram Bot API сервер
const USE_LOCAL_API = process.env.USE_LOCAL_API === 'true';
const LOCAL_API_URL = process.env.LOCAL_API_URL || 'http://localhost:8081';

// Если используем локальный API, переопределяем baseURL через monkey patching
if (USE_LOCAL_API) {
  // Переопределяем метод _request для использования локального сервера
  const originalRequest = (TelegramBot as any).prototype._request;
  
  (TelegramBot as any).prototype._request = function(options: any, callback: any) {
    // Заменяем стандартный URL на локальный
    if (options.url && typeof options.url === 'string' && options.url.includes('api.telegram.org')) {
      options.url = options.url.replace('https://api.telegram.org', LOCAL_API_URL);
      console.log(`Local API request: ${options.url}`);
    }
    return originalRequest.call(this, options, callback);
  };
  
  console.log(`Using local Telegram Bot API at ${LOCAL_API_URL} (files up to 2GB)`);
} else {
  console.log('Using standard Telegram Bot API (20MB limit)');
}

const botOptions: any = { 
  polling: {
    interval: 2000, // Увеличиваем интервал до 2 секунд для снижения нагрузки
    autoStart: false, // Отключаем автозапуск, запустим вручную с задержкой
    params: {
      timeout: 30, // Увеличиваем timeout
      limit: 1, // Получаем по 1 обновлению за раз
      allowed_updates: ['message', 'callback_query'] // Только нужные типы обновлений
    }
  }
};

// Если используем локальный API, добавляем baseApiUrl
if (USE_LOCAL_API) {
  botOptions.baseApiUrl = LOCAL_API_URL;
  console.log(`Bot will use local API: ${LOCAL_API_URL}`);
}

const bot = new TelegramBot(BOT_TOKEN, botOptions);

// Переопределяем методы бота для автоматической обработки rate limiting
const originalSendMessage = bot.sendMessage.bind(bot);
const originalSendVideo = bot.sendVideo.bind(bot);

bot.sendMessage = async function(chatId: number, text: string, options?: any): Promise<any> {
  return await rateLimitedRequest(async () => {
    for (let i = 0; i < 3; i++) {
      try {
        return await originalSendMessage(chatId, text, options);
      } catch (error: any) {
        if (error.code === 'ETELEGRAM' && error.response?.statusCode === 429) {
          const retryAfter = error.response?.body?.parameters?.retry_after || 1;
          console.warn(`[Rate Limit] sendMessage получил 429, жду ${retryAfter} секунд...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        }
        throw error;
      }
    }
    throw new Error('Не удалось отправить сообщение после нескольких попыток');
  });
};

bot.sendVideo = async function(chatId: number, videoPath: string, options?: any): Promise<any> {
  return await rateLimitedRequest(async () => {
    for (let i = 0; i < 3; i++) {
      try {
        return await originalSendVideo(chatId, videoPath, options);
      } catch (error: any) {
        if (error.code === 'ETELEGRAM' && error.response?.statusCode === 429) {
          const retryAfter = error.response?.body?.parameters?.retry_after || 1;
          console.warn(`[Rate Limit] sendVideo получил 429, жду ${retryAfter} секунд...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        }
        throw error;
      }
    }
    throw new Error('Не удалось отправить видео после нескольких попыток');
  });
};

// Задержка между запросами для предотвращения rate limiting
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 50; // 50ms между запросами (20 запросов/сек максимум)

async function rateLimitedRequest<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
  }
  lastRequestTime = Date.now();
  return await fn();
}

let isPollingPaused = false;
let pollingPauseUntil = 0;

bot.on('polling_error', async (error: any) => {
  if (error.code === 'ETELEGRAM' && error.response?.statusCode === 429) {
    const retryAfter = error.response?.body?.parameters?.retry_after || 60;
    const pauseUntil = Date.now() + (retryAfter * 1000);
    pollingPauseUntil = pauseUntil;
    
    if (!isPollingPaused) {
      isPollingPaused = true;
      console.warn(`[Polling Rate Limit] Получен 429, останавливаю polling на ${retryAfter} секунд...`);
      
      try {
        await bot.stopPolling();
        console.log('[Polling] Polling остановлен');
      } catch (e) {
        console.warn('[Polling] Ошибка при остановке polling:', e);
      }
      
      // Перезапускаем polling после задержки
      const restartDelay = Math.max(retryAfter * 1000, 1000); // Минимум 1 секунда
      setTimeout(async () => {
        const now = Date.now();
        if (now >= pollingPauseUntil) {
          console.log(`[Polling] Перезапускаю polling (прошло ${Math.floor((now - (pollingPauseUntil - retryAfter * 1000)) / 1000)} секунд)...`);
          isPollingPaused = false;
          pollingPauseUntil = 0;
          
          // Небольшая дополнительная задержка перед перезапуском
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          try {
            await bot.startPolling();
            console.log('[Polling] Polling успешно перезапущен');
          } catch (e: any) {
            console.error('[Polling] Ошибка при перезапуске polling:', e);
            if (e.code === 'ETELEGRAM' && e.response?.statusCode === 429) {
              // Если снова 429, повторяем процесс
              const newRetryAfter = e.response?.body?.parameters?.retry_after || 60;
              console.warn(`[Polling] Снова получен 429, жду ${newRetryAfter} секунд...`);
              isPollingPaused = true;
              pollingPauseUntil = Date.now() + (newRetryAfter * 1000);
              setTimeout(async () => {
                try {
                  await bot.startPolling();
                  isPollingPaused = false;
                  console.log('[Polling] Polling перезапущен после повторной задержки');
                } catch (err) {
                  console.error('[Polling] Критическая ошибка при перезапуске:', err);
                }
              }, newRetryAfter * 1000);
            } else {
              // Для других ошибок повторяем попытку через минуту
              setTimeout(async () => {
                try {
                  await bot.startPolling();
                  isPollingPaused = false;
                  console.log('[Polling] Polling перезапущен после ошибки');
                } catch (err) {
                  console.error('[Polling] Ошибка при повторном перезапуске:', err);
                }
              }, 60000);
            }
          }
        } else {
          console.warn(`[Polling] Ещё рано перезапускать (осталось ${Math.floor((pollingPauseUntil - now) / 1000)} секунд)`);
        }
      }, restartDelay);
    } else {
      console.warn(`[Polling Rate Limit] Polling уже приостановлен до ${new Date(pollingPauseUntil).toISOString()}`);
    }
  } else {
    console.error('Polling error:', error);
    // Для других ошибок не останавливаем polling, но логируем
  }
});

bot.on('error', (error) => {
  console.error('Bot error:', error);
});

console.log('Telegram bot initialized');

// Запускаем polling с задержкой, чтобы избежать 429 при старте
// Если бот был заблокирован, даём время на разблокировку
setTimeout(async () => {
  try {
    console.log('[Polling] Запускаю polling с задержкой...');
    await bot.startPolling();
    console.log('[Polling] Polling успешно запущен');
  } catch (error: any) {
    console.error('[Polling] Ошибка при запуске polling:', error);
    if (error.code === 'ETELEGRAM' && error.response?.statusCode === 429) {
      const retryAfter = error.response?.body?.parameters?.retry_after || 60;
      console.warn(`[Polling] Получен 429 при старте, жду ${retryAfter} секунд перед повтором...`);
      setTimeout(async () => {
        try {
          await bot.startPolling();
          console.log('[Polling] Polling запущен после задержки');
        } catch (e) {
          console.error('[Polling] Ошибка при повторном запуске:', e);
        }
      }, retryAfter * 1000);
    }
  }
}, 5000); // Задержка 5 секунд перед запуском polling

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}
app.use('/temp', express.static(tempDir, {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

const assetsDir = path.join(__dirname, 'assets');
app.use('/assets', express.static(assetsDir, {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

interface UserState {
  step: 'start' | 'waiting_template' | 'waiting_videos' | 'waiting_info' | 'ready';
  template?: 'grid' | 'news';
  videos?: { fileId: string; isDocument?: boolean }[];
  countries?: string[];
  date?: string;
  country?: string;
  newsDate?: string;
  newsTickers?: string[];
}

const userStates = new Map<number, UserState>();

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  userStates.set(chatId, { step: 'start' });
  
  await bot.sendMessage(chatId, 'Привет! Я бот для создания видео-клипов. 🎥\n\n' +
    'Выберите шаблон:', {
    reply_markup: {
      keyboard: [
        [{ text: '1. Сетка 4 видео (Grid)' }],
        [{ text: '2. Новости (News)' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
  
  userStates.get(chatId)!.step = 'waiting_template';
});

bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (text === '/start') return;
    
    const state = userStates.get(chatId);
    if (!state) {
      // Если нет состояния, но пользователь отправил сообщение, показываем меню
      if (text || msg.video || msg.document) {
        await bot.sendMessage(chatId, 'Пожалуйста, начните с команды /start или выберите шаблон:', {
          reply_markup: {
            keyboard: [
              [{ text: '1. Сетка 4 видео (Grid)' }],
              [{ text: '2. Новости (News)' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        });
        userStates.set(chatId, { step: 'waiting_template' });
      }
      return;
    }

  if (state.step === 'waiting_template') {
    if (text === '1. Сетка 4 видео (Grid)') {
      state.template = 'grid';
      state.step = 'waiting_videos';
      state.videos = [];
      await bot.sendMessage(chatId, '🎬 Шаблон 1: Сетка\n\nОтправьте мне 4 видеофайла.');
    } else if (text === '2. Новости (News)') {
      state.template = 'news';
      state.step = 'waiting_videos';
      state.videos = [];
      await bot.sendMessage(chatId, '📰 Шаблон 2: Новости\n\nОтправьте мне 5 видеофайлов.');
    } else {
      await bot.sendMessage(chatId, 'Пожалуйста, используйте кнопки меню.');
    }
    return;
  }

  if (state.step === 'waiting_videos') {
    if (msg.video || msg.document) {
      const fileId = msg.video?.file_id || msg.document?.file_id;
      const fileSize = msg.video?.file_size || msg.document?.file_size || 0;
      const isDocument = !!msg.document; // true если файл отправлен как документ

      if (fileId) {
        state.videos!.push({ fileId, isDocument });
        
        const requiredCount = state.template === 'grid' ? 4 : 5;
        const currentCount = state.videos!.length;
        
        if (currentCount < requiredCount) {
          await bot.sendMessage(chatId, `Получено видео ${currentCount}/${requiredCount}. Отправьте еще.`);
        } else {
          state.step = 'waiting_info';
          if (state.template === 'grid') {
          await bot.sendMessage(chatId, 
            'Все видео получены! 📝\n\n' +
            'Отправь одной строкой: страны через запятую / дата.\n' +
            'Пример: Индонезия, Бразилия, Япония, Саудовская Аравия / 7-8 декабря 2025'
          );
          } else {
             await bot.sendMessage(chatId,
              'Все видео получены! 📝\n\n' +
              'Отправьте одним сообщением:\n' +
              '1. Дата (например: 16 ноября 2025)\n' +
              '2. Страна (например: Палестина)\n' +
              '3. Текст новости (я сам перепишу его красиво с помощью AI)'
            );
          }
        }
      }
    }
    return;
  }

  if (state.step === 'waiting_info' && text) {
    if (state.template === 'grid') {
      const lines = text.split('\n').filter(l => l.trim());
      let countriesLine = '';
      let dateLine = '';

      if (lines.length >= 2) {
        countriesLine = lines[0].trim();
        dateLine = lines[1].trim();
      } else {
        // Пытаемся разобрать формат "страны / дата" или "страны | дата"
        const splitted = text.split(/[\/|]/).map(s => s.trim()).filter(Boolean);
        if (splitted.length >= 2) {
          countriesLine = splitted[0];
          dateLine = splitted.slice(1).join(' / ');
        }
      }

      if (countriesLine && dateLine) {
        state.countries = countriesLine.split(',').map(c => c.trim()).filter(c => c);
        state.date = dateLine;
        state.step = 'ready';
        await processGridTemplate(chatId, state);
      } else {
        await bot.sendMessage(chatId, '❌ Отправь одной строкой: страны через запятую / дата.\nПример: Индонезия, Бразилия, Япония, Саудовская Аравия / 7-8 декабря 2025');
      }
    } else if (state.template === 'news') {
       const lines = text.split('\n').filter(l => l.trim());
       
       if (lines.length >= 3) {
         // НОВЫЙ ПОРЯДОК: 1. Дата, 2. Страна
         state.newsDate = lines[0].trim();
         state.country = lines[1].trim();
         
         const rawDescription = lines.slice(2).join(' ').trim();
         
         if (!PERPLEXITY_API_KEY) {
           await bot.sendMessage(chatId, '⚠️ AI ключ недоступен, делю текст алгоритмически.');
         } else {
           await bot.sendMessage(chatId, '🤖 AI обрабатывает ваш текст...');
         }
         
         try {
             let tickers = await rewriteNewsText(rawDescription);
             
            // Страховка: если AI вернул < 3 блоков или это не массив
            if (!Array.isArray(tickers) || tickers.length < 3) {
                const words = rawDescription.split(/\s+/);
                const total = words.length;
                
                // Сбалансированное разбиение на 3 блока
                const baseSize = Math.floor(total / 3);
                const remainder = total % 3;
                
                tickers = [];
                let startIdx = 0;
                for (let i = 0; i < 3; i++) {
                    const size = baseSize + (i < remainder ? 1 : 0);
                    tickers.push(words.slice(startIdx, startIdx + size).join(' '));
                    startIdx += size;
                }
             }
             
             // Обрезаем или дополняем до 3
             state.newsTickers = tickers.slice(0, 3);
             while (state.newsTickers.length < 3) state.newsTickers.push('');
             
             state.step = 'ready';
             await processNewsTemplate(chatId, state);
         } catch (e) {
             console.error('AI Error:', e);
             await bot.sendMessage(chatId, '❌ Ошибка AI обработки. Попробуйте еще раз.');
         }
      } else {
         await bot.sendMessage(chatId, '❌ Отправьте: Дата (строка 1), Страна (строка 2), Текст (далее)');
      }
    }
  }  // конец if (state.step === 'waiting_info' && text)
  } catch (error) {
    console.error('Error handling message:', error);
    try {
      await bot.sendMessage(msg.chat.id, '❌ Произошла ошибка при обработке сообщения. Попробуйте еще раз или начните с /start');
    } catch (sendError) {
      console.error('Error sending error message:', sendError);
    }
  }
});

async function validateVideoFiles(files: string[]) {
  for (const file of files) {
    const stats = await fs.promises.stat(file);
    if (stats.size === 0) throw new Error(`File empty: ${file}`);
  }
}

async function processGridTemplate(chatId: number, state: UserState) {
  const videoPaths: string[] = [];
  const trimmedPaths: string[] = [];
  try {
    const started = Date.now();
    await bot.sendMessage(chatId, '⏳ Начинаю обработку Grid...');
    
    for (const v of state.videos!) {
        // Проверяем, был ли файл отправлен как документ (хранится в fileId, но нужно проверить тип)
        // Для простоты считаем, что если getFile() не работает, то это видео >20 МБ
        const path = await downloadFile(bot, v.fileId, BOT_TOKEN!, v.isDocument);
        videoPaths.push(path);
    }
    
    await validateVideoFiles(videoPaths);

    // Для grid НЕ обрезаем видео - они играются полностью (20 секунд контента)
    // Используем исходные видео без обрезки
    trimmedPaths.push(...videoPaths);
    
    await bot.sendMessage(chatId, '🎬 Рендерю...');
    const webmPath = await renderVideo({
        template: 'grid',
        videos: trimmedPaths,
        countries: state.countries,
        date: state.date
    }, Number(PORT));
    
    await bot.sendMessage(chatId, '🔄 Конвертирую...');
    
    // Создаем имя файла на основе даты и "Весь мир" (для grid template)
    const sanitizeFileName = (str: string): string => {
      return str
        .replace(/[^\w\s-]/g, '') // Убираем спецсимволы
        .replace(/\s+/g, '_') // Заменяем пробелы на подчеркивания
        .replace(/_+/g, '_') // Убираем множественные подчеркивания
        .trim();
    };
    
    const dateStr = state.date ? sanitizeFileName(state.date) : 'date';
    const fileName = `${dateStr}_Весь_мир.mp4`;
    
    const mp4Path = await convertWebmToMp4(webmPath, fileName, 30);
    
    await bot.sendVideo(chatId, mp4Path);
    
    // Для grid trimmedPaths = videoPaths, поэтому убираем дубликаты
    const filesToCleanup = [...new Set([...videoPaths, ...trimmedPaths, webmPath, mp4Path])];
    await cleanupFiles(filesToCleanup);
    userStates.delete(chatId);
    console.log(`Grid done in ${(Date.now() - started) / 1000}s`);
    
    // Показываем меню снова для следующего клипа
    await bot.sendMessage(chatId, '✅ Клип готов! Хотите создать ещё один?', {
      reply_markup: {
        keyboard: [
          [{ text: '1. Сетка 4 видео (Grid)' }],
          [{ text: '2. Новости (News)' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
    userStates.set(chatId, { step: 'waiting_template' });
    
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    console.error(e);
    
    // Показываем меню даже при ошибке
    userStates.delete(chatId);
    await bot.sendMessage(chatId, 'Выберите шаблон для нового клипа:', {
      reply_markup: {
        keyboard: [
          [{ text: '1. Сетка 4 видео (Grid)' }],
          [{ text: '2. Новости (News)' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
    userStates.set(chatId, { step: 'waiting_template' });
  }
}

async function processNewsTemplate(chatId: number, state: UserState) {
  const videoPaths: string[] = [];
  const trimmedPaths: string[] = [];
  try {
    const started = Date.now();
    await bot.sendMessage(chatId, '⏳ Начинаю обработку News...');
    
    for (const v of state.videos!) {
        // Проверяем, был ли файл отправлен как документ (хранится в fileId, но нужно проверить тип)
        // Для простоты считаем, что если getFile() не работает, то это видео >20 МБ
        const path = await downloadFile(bot, v.fileId, BOT_TOKEN!, v.isDocument);
        videoPaths.push(path);
    }
    
    await validateVideoFiles(videoPaths);

    // Обрезаем каждое видео до 6 секунд, чтобы не превышать лимиты и ускорить рендер (оставляем исходный FPS)
    for (const p of videoPaths) {
      const trimmed = await trimVideoToDuration(p, 6);
      trimmedPaths.push(trimmed);
    }
    
    await bot.sendMessage(chatId, '🎬 Рендерю...');
    const webmPath = await renderVideo({
        template: 'news',
        videos: trimmedPaths,
        country: state.country,
        date: state.newsDate,
        tickers: state.newsTickers
    }, Number(PORT));
    
    await bot.sendMessage(chatId, '🔄 Конвертирую...');
    
    // Создаем имя файла на основе даты и страны (для news template)
    const sanitizeFileName = (str: string): string => {
      return str
        .replace(/[^\w\s-]/g, '') // Убираем спецсимволы
        .replace(/\s+/g, '_') // Заменяем пробелы на подчеркивания
        .replace(/_+/g, '_') // Убираем множественные подчеркивания
        .trim();
    };
    
    const dateStr = state.newsDate ? sanitizeFileName(state.newsDate) : 'date';
    const countryStr = state.country ? sanitizeFileName(state.country) : 'country';
    const fileName = `${dateStr}_${countryStr}.mp4`;
    
    const mp4Path = await convertWebmToMp4(webmPath, fileName, 60);
    
    // Генерируем озвучку для ticker'ов через OpenAI TTS
    let finalVideoPath = mp4Path;
    let audioPath: string | null = null;
    
    if (state.newsTickers && state.newsTickers.length > 0 && state.newsTickers.some(t => t && t.trim().length > 0)) {
      try {
        await bot.sendMessage(chatId, '🎙️ Озвучиваю текст...');
        
        // Константы тайминга (должны совпадать с videoRenderer.ts)
        const NEWS_INITIAL_SILENCE = 2; // Тишина в начале (пользователь может перелистнуть)
        const NEWS_HEADER_DURATION = 2; // секунды показа шапки (первые 2 секунды)
        const NEWS_CLIP_COUNT = 5; // количество роликов
        const NEWS_CLIP_DURATION = 6; // длительность каждого ролика
        const CTA_DURATION = 5; // призыв к действию
        const NEWS_TICKER_COUNT = 3;
        const NEWS_TICKER_DURATION = (NEWS_CLIP_COUNT * NEWS_CLIP_DURATION + CTA_DURATION - NEWS_INITIAL_SILENCE - CTA_DURATION) / NEWS_TICKER_COUNT;
        const NEWS_CONTENT_DURATION = NEWS_INITIAL_SILENCE + NEWS_TICKER_DURATION * NEWS_TICKER_COUNT;
        const TOTAL_DURATION = NEWS_CONTENT_DURATION + CTA_DURATION; // 35 секунд
        
        audioPath = await generateNewsAudioTrack(
          state.newsTickers,
          NEWS_INITIAL_SILENCE,
          NEWS_TICKER_DURATION,
          TOTAL_DURATION
        );
        
        await bot.sendMessage(chatId, '🔊 Добавляю озвучку к видео...');
        
        // Добавляем аудио к видео (заменяем оригинальное аудио)
        const finalPath = mp4Path.replace('.mp4', '_with_audio.mp4');
        await addAudioToVideo(mp4Path, audioPath, finalPath, false);
        
        finalVideoPath = finalPath;
        
      } catch (error) {
        console.error('[OpenAI TTS] Ошибка при озвучке:', error);
        await bot.sendMessage(chatId, `⚠️ Не удалось добавить озвучку: ${error instanceof Error ? error.message : String(error)}. Отправляю видео без озвучки.`);
        // Продолжаем без озвучки
      }
    }
    
    await bot.sendVideo(chatId, finalVideoPath);
    
    // Очищаем файлы (включая аудио, если было создано)
    const filesToCleanup = [...videoPaths, ...trimmedPaths, webmPath];
    if (audioPath) {
      filesToCleanup.push(audioPath);
    }
    // Удаляем промежуточный MP4 без аудио, если был создан финальный с аудио
    if (finalVideoPath !== mp4Path) {
      filesToCleanup.push(mp4Path);
    }
    // Финальный файл (finalVideoPath) не удаляем - он уже отправлен пользователю
    await cleanupFiles(filesToCleanup);
    userStates.delete(chatId);
    console.log(`News done in ${(Date.now() - started) / 1000}s`);
    
    // Показываем меню снова для следующего клипа
    await bot.sendMessage(chatId, '✅ Клип готов! Хотите создать ещё один?', {
      reply_markup: {
        keyboard: [
          [{ text: '1. Сетка 4 видео (Grid)' }],
          [{ text: '2. Новости (News)' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
    userStates.set(chatId, { step: 'waiting_template' });
    
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    console.error(e);
    
    // Показываем меню даже при ошибке
    userStates.delete(chatId);
    await bot.sendMessage(chatId, 'Выберите шаблон для нового клипа:', {
      reply_markup: {
        keyboard: [
          [{ text: '1. Сетка 4 видео (Grid)' }],
          [{ text: '2. Новости (News)' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
    userStates.set(chatId, { step: 'waiting_template' });
  }
}

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    bot: BOT_TOKEN ? 'configured' : 'missing',
    port: PORT 
  });
});

app.post('/upload-result/:id', (req, res) => {
  const { id } = req.params;
  const filePath = path.join(tempDir, `${id}.webm`);
  const writeStream = fs.createWriteStream(filePath);
  
  req.pipe(writeStream);
  
  writeStream.on('finish', () => {
    console.log(`Video upload received: ${filePath}`);
    res.sendStatus(200);
  });
  
  writeStream.on('error', (err) => {
    console.error('File write error:', err);
    res.status(500).send(err.message);
  });
});

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`✅ Bot server running on port ${PORT}`);
  console.log(`✅ Health check available at http://0.0.0.0:${PORT}/health`);
  console.log(`✅ Bot is ready to receive messages`);
});