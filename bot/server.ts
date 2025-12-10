import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { config } from 'dotenv';
import { renderVideo } from './videoRenderer.js';
import { convertWebmToMp4 } from './videoConverter.js';
import { downloadFile, cleanupFiles } from './fileManager.js';
import { rewriteNewsText } from './aiService.js';
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
const MAX_TG_FILE_SIZE_MB = 20;
const MAX_TG_FILE_SIZE = MAX_TG_FILE_SIZE_MB * 1024 * 1024;

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

const bot = new TelegramBot(BOT_TOKEN, { 
  polling: {
    interval: 300,
    autoStart: true,
    params: {
      timeout: 10
    }
  }
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

bot.on('error', (error) => {
  console.error('Bot error:', error);
});

console.log('Telegram bot initialized');

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
  videos?: { fileId: string }[];
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
  const chatId = msg.chat.id;
  const text = msg.text;
  
  if (text === '/start') return;
  
  const state = userStates.get(chatId);
  if (!state) return;

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

      if (fileSize > MAX_TG_FILE_SIZE) {
        await bot.sendMessage(chatId, `❌ Файл слишком большой (${(fileSize / 1024 / 1024).toFixed(1)} МБ). Telegram Bot API позволяет скачивать до ${MAX_TG_FILE_SIZE_MB} МБ. Сожмите видео или отправьте файл меньше ${MAX_TG_FILE_SIZE_MB} МБ.`);
        return;
      }

      if (fileId) {
        state.videos!.push({ fileId });
        
        const requiredCount = state.template === 'grid' ? 4 : 5;
        const currentCount = state.videos!.length;
        
        if (currentCount < requiredCount) {
          await bot.sendMessage(chatId, `Получено видео ${currentCount}/${requiredCount}. Отправьте еще.`);
        } else {
          state.step = 'waiting_info';
          if (state.template === 'grid') {
            await bot.sendMessage(chatId, 
              'Все видео получены! 📝\n\n' +
              'Теперь отправьте информацию в формате:\n' +
              'Страна1, Страна2, Страна3, Страна4\n' +
              'Дата (или описание по центру)'
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
      // ... (Grid logic unchanged) ...
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
                 
                 // Сбалансированное разбиение: 10 слов -> 4, 3, 3 (а не 4, 4, 2)
                 const baseSize = Math.floor(total / 3);
                 const remainder = total % 3;
                 
                 const size1 = baseSize + (remainder > 0 ? 1 : 0);
                 const size2 = baseSize + (remainder > 1 ? 1 : 0);
                 // size3 = baseSize
                 
                 tickers = [
                    words.slice(0, size1).join(' '),
                    words.slice(size1, size1 + size2).join(' '),
                    words.slice(size1 + size2).join(' ')
                 ];
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
         await bot.sendMessage(chatId, '❌ Отправьте: Страна (строка 1), Дата (строка 2), Текст (далее)');
       }
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
        const path = await downloadFile(bot, v.fileId, BOT_TOKEN!);
        videoPaths.push(path);
    }
    
    await validateVideoFiles(videoPaths);

    // Обрезаем каждое видео до 6 секунд, чтобы не превышать лимиты и ускорить рендер
    for (const p of videoPaths) {
      const trimmed = await trimVideoToDuration(p, 6);
      trimmedPaths.push(trimmed);
    }
    
    await bot.sendMessage(chatId, '🎬 Рендерю...');
    const webmPath = await renderVideo({
        template: 'grid',
        videos: trimmedPaths,
        countries: state.countries,
        date: state.date
    }, Number(PORT));
    
    await bot.sendMessage(chatId, '🔄 Конвертирую...');
    const mp4Path = await convertWebmToMp4(webmPath);
    
    await bot.sendVideo(chatId, mp4Path);
    
    await cleanupFiles([...videoPaths, ...trimmedPaths, webmPath, mp4Path]);
    userStates.delete(chatId);
    console.log(`Grid done in ${(Date.now() - started) / 1000}s`);
    
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    console.error(e);
  }
}

async function processNewsTemplate(chatId: number, state: UserState) {
  const videoPaths: string[] = [];
  const trimmedPaths: string[] = [];
  try {
    const started = Date.now();
    await bot.sendMessage(chatId, '⏳ Начинаю обработку News...');
    
    for (const v of state.videos!) {
        const path = await downloadFile(bot, v.fileId, BOT_TOKEN!);
        videoPaths.push(path);
    }
    
    await validateVideoFiles(videoPaths);

    // Обрезаем каждое видео до 6 секунд, чтобы не превышать лимиты и ускорить рендер
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
    const mp4Path = await convertWebmToMp4(webmPath);
    
    await bot.sendVideo(chatId, mp4Path);
    
    await cleanupFiles([...videoPaths, ...trimmedPaths, webmPath, mp4Path]);
    userStates.delete(chatId);
    console.log(`News done in ${(Date.now() - started) / 1000}s`);
    
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    console.error(e);
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Bot server running on port ${PORT}`);
  console.log(`✅ Health check available at http://0.0.0.0:${PORT}/health`);
  console.log(`✅ Bot is ready to receive messages`);
});