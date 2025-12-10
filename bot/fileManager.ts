import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

// Настраиваем путь к ffmpeg для fluent-ffmpeg
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_DIR = path.join(__dirname, 'temp');
const MAX_RETRIES = 3;
const DOWNLOAD_TIMEOUT = 10 * 60 * 1000; // 10 минут
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

// Создаем временную директорию
export async function ensureTempDir() {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  } catch (error) {
    // Директория уже существует
  }
}

// Проверка существования файла и его размера
async function validateFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size > 0;
  } catch {
    return false;
  }
}

// Удаление неполного файла
async function cleanupIncompleteFile(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch {
    // Игнорируем ошибки удаления
  }
}

// Обрезка и сжатие видео до заданной длительности с максимальным качеством (<20 МБ)
export async function trimVideoToDuration(
  inputPath: string,
  durationSec: number = 6
): Promise<string> {
  await ensureTempDir();
  const ext = path.extname(inputPath) || '.mp4';
  const base = path.basename(inputPath, ext);
  const maxSizeBytes = 20 * 1024 * 1024; // 20 МБ
  
  // Пробуем разные варианты сжатия для максимального качества
  const attempts = [
    // HEVC (H.265) с CRF 20 - лучшее качество при меньшем размере
    {
      codec: 'libx265',
      crf: 20,
      preset: 'slow',
      audio: 'aac',
      audioBitrate: '128k',
      suffix: '_h265_crf20'
    },
    // HEVC с CRF 22 - чуть больше сжатие, но всё ещё отличное качество
    {
      codec: 'libx265',
      crf: 22,
      preset: 'slow',
      audio: 'aac',
      audioBitrate: '128k',
      suffix: '_h265_crf22'
    },
    // x264 с CRF 20 - если HEVC не поддерживается
    {
      codec: 'libx264',
      crf: 20,
      preset: 'slow',
      audio: 'aac',
      audioBitrate: '96k',
      suffix: '_x264_crf20'
    },
    // x264 с CRF 22 - последний вариант
    {
      codec: 'libx264',
      crf: 22,
      preset: 'medium',
      audio: 'aac',
      audioBitrate: '96k',
      suffix: '_x264_crf22'
    }
  ];

  for (const attempt of attempts) {
    const outputPath = path.join(TEMP_DIR, `${base}_trim${attempt.suffix}${ext}`);
    
    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions([
            `-t ${durationSec}`,
            `-c:v ${attempt.codec}`,
            `-crf ${attempt.crf}`,
            `-preset ${attempt.preset}`,
            `-pix_fmt yuv420p`,
            `-c:a ${attempt.audio}`,
            `-b:a ${attempt.audioBitrate}`,
            `-movflags +faststart`
          ])
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .save(outputPath);
      });

      // Проверяем размер файла
      const stats = await fs.stat(outputPath);
      if (stats.size <= maxSizeBytes) {
        console.log(`Video compressed: ${(stats.size / 1024 / 1024).toFixed(2)}MB using ${attempt.codec} CRF ${attempt.crf}`);
        return outputPath;
      } else {
        // Удаляем слишком большой файл и пробуем следующий вариант
        await fs.unlink(outputPath).catch(() => {});
        console.log(`Attempt ${attempt.codec} CRF ${attempt.crf} too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB, trying next...`);
      }
    } catch (error) {
      // Если кодек не поддерживается, пробуем следующий
      console.log(`Codec ${attempt.codec} failed, trying next...`);
      await fs.unlink(outputPath).catch(() => {});
      continue;
    }
  }

  // Если все варианты не подошли, возвращаем хотя бы обрезанное видео
  const fallbackPath = path.join(TEMP_DIR, `${base}_trim_fallback${ext}`);
  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([`-t ${durationSec}`, `-c copy`])
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(fallbackPath);
  });
  
  return fallbackPath;
}

// Скачивание файла с retry механизмом
async function downloadFileWithRetry(
  fileUrl: string,
  localPath: string,
  retryCount: number = 0
): Promise<void> {
  return new Promise((resolve, reject) => {
    const writeStream = createWriteStream(localPath);
    let downloadedBytes = 0;
    let timeout: NodeJS.Timeout | null = null;
    let request: http.ClientRequest | null = null;
    let isCompleted = false;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };

    const resetTimeout = () => {
      cleanup();
      timeout = setTimeout(() => {
        if (!isCompleted) {
          writeStream.destroy();
          if (request) request.destroy();
          reject(new Error('Download timeout: превышено время ожидания'));
        }
      }, DOWNLOAD_TIMEOUT);
    };

    const onError = async (error: Error) => {
      cleanup();
      writeStream.destroy();
      if (request) request.destroy();
      
      // Удаляем неполный файл
      await cleanupIncompleteFile(localPath);
      
      // Retry для сетевых ошибок
      if (retryCount < MAX_RETRIES && (
        error.message.includes('ECONNRESET') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('socket hang up') ||
        error.message.includes('ENOTFOUND') ||
        error.message.includes('ECONNREFUSED')
      )) {
        console.log(`Retry ${retryCount + 1}/${MAX_RETRIES} for ${path.basename(localPath)}`);
        await new Promise(resolve => setTimeout(resolve, 2000 * (retryCount + 1))); // Экспоненциальная задержка
        return downloadFileWithRetry(fileUrl, localPath, retryCount + 1)
          .then(resolve)
          .catch(reject);
      }
      
      reject(error);
    };

    resetTimeout();

    // Определяем протокол из URL
    const url = new URL(fileUrl);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    request = httpModule.get(fileUrl, {
      timeout: DOWNLOAD_TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TelegramBot/1.0)',
        'Accept': '*/*',
        'Connection': 'keep-alive'
      }
    }, async (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Редирект
        cleanup();
        writeStream.destroy();
        if (request) request.destroy();
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          await cleanupIncompleteFile(localPath);
          return downloadFileWithRetry(redirectUrl, localPath, retryCount)
            .then(resolve)
            .catch(reject);
        }
        return onError(new Error(`Unexpected redirect: ${response.statusCode}`));
      }

      if (response.statusCode !== 200) {
        cleanup();
        writeStream.destroy();
        await cleanupIncompleteFile(localPath);
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage || 'Unknown error'}`));
        return;
      }

      const contentLength = parseInt(response.headers['content-length'] || '0', 10);
      
      // Проверка размера файла
      if (contentLength > MAX_FILE_SIZE) {
        cleanup();
        writeStream.destroy();
        await cleanupIncompleteFile(localPath);
        reject(new Error(`File too large: ${(contentLength / 1024 / 1024).toFixed(2)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`));
        return;
      }

      console.log(`Downloading: ${path.basename(localPath)} (${(contentLength / 1024 / 1024).toFixed(2)}MB)`);

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        resetTimeout(); // Обновляем таймаут при получении данных
        
        // Проверка размера во время скачивания
        if (downloadedBytes > MAX_FILE_SIZE) {
          cleanup();
          writeStream.destroy();
          if (request) request.destroy();
          cleanupIncompleteFile(localPath);
          reject(new Error('File size exceeded during download'));
        }
      });

      response.on('end', () => {
        cleanup();
        if (!isCompleted) {
          isCompleted = true;
          writeStream.end();
        }
      });

      response.on('error', onError);

      response.pipe(writeStream);

      writeStream.on('finish', async () => {
        cleanup();
        isCompleted = true;
        
        // Валидация скачанного файла
        const isValid = await validateFile(localPath);
        if (!isValid) {
          await cleanupIncompleteFile(localPath);
          reject(new Error('Downloaded file is invalid or empty'));
          return;
        }
        
        console.log(`Downloaded: ${path.basename(localPath)} (${(downloadedBytes / 1024 / 1024).toFixed(2)}MB)`);
        resolve();
      });

      writeStream.on('error', onError);
    });

    request.on('error', onError);
    request.on('timeout', () => {
      cleanup();
      if (request) request.destroy();
      writeStream.destroy();
      onError(new Error('Request timeout'));
    });
    request.setTimeout(DOWNLOAD_TIMEOUT);
  });
}

// Скачивание файла из Telegram
export async function downloadFile(
  bot: TelegramBot,
  fileId: string,
  botToken?: string,
  isDocument?: boolean  // true если файл отправлен как документ
): Promise<string> {
  await ensureTempDir();
  
  let file;
  let retryCount = 0;
  
  // Получаем токен заранее (может понадобиться для getFileLink())
  const token = botToken || (bot as any).token || process.env.BOT_TOKEN;
  if (!token) {
    throw new Error('Bot token not available');
  }
  
  // Проверяем, используем ли локальный API
  const useLocalApi = process.env.USE_LOCAL_API === 'true';
  const localApiUrl = process.env.LOCAL_API_URL || 'http://localhost:8081';
  
  if (useLocalApi) {
    console.log(`Using local API for getFile: ${localApiUrl}`);
  } else {
    console.log('Using standard Telegram Bot API for getFile (20MB limit)');
  }
  
  // Retry для получения информации о файле
  while (retryCount < MAX_RETRIES) {
    try {
      file = await bot.getFile(fileId);
      console.log('File info:', JSON.stringify(file)); // Логируем информацию о файле
      break;
    } catch (error: any) {
      retryCount++;
      // Обработка ошибки размера файла
      if (error?.message?.includes('file is too big') || error?.message?.includes('too large')) {
        const fileSizeMB = error?.response?.body?.file_size 
          ? (error.response.body.file_size / 1024 / 1024).toFixed(1)
          : '>20';
        
        // Если файл отправлен как документ, getFileLink() должен работать до 50 МБ
        if (isDocument) {
          console.log(`Document file too large for getFile() (${fileSizeMB} МБ), trying getFileLink()...`);
          try {
            const directUrl = await bot.getFileLink(fileId);
            console.log(`Got direct download URL via getFileLink() for document ${fileSizeMB} МБ`);
            const fileName = `file_${Date.now()}_${fileId}.mp4`;
            const localPath = path.join(TEMP_DIR, fileName);
            await downloadFileWithRetry(directUrl, localPath);
            console.log(`Successfully downloaded document (${fileSizeMB} МБ) via getFileLink()`);
            return localPath;
          } catch (linkError: any) {
            console.error('getFileLink() failed for document:', linkError.message);
            throw new Error(`Не удалось скачать документ (${fileSizeMB} МБ). Попробуйте отправить файл меньшего размера.`);
          }
        }
        
        // Для видео >20 МБ нужно отправлять как документ
        throw new Error(`Файл слишком большой (${fileSizeMB} МБ). Telegram Bot API позволяет скачивать видео до 20 МБ.\n\n💡 Решение: отправьте файл как документ (File/Document) вместо видео - для документов лимит 50 МБ, и бот автоматически обрежет и сожмет его до 6 секунд с максимальным качеством.`);
      }
      if (retryCount >= MAX_RETRIES) {
        throw new Error(`Failed to get file info after ${MAX_RETRIES} attempts: ${error.message || String(error)}`);
      }
      console.log(`Retry getting file info ${retryCount}/${MAX_RETRIES}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
    }
  }
  
  if (!file || !file.file_path) {
    throw new Error('File path not available from Telegram API');
  }
  
  const fileName = path.basename(file.file_path) || `file_${Date.now()}.mp4`;
  const localPath = path.join(TEMP_DIR, `${Date.now()}_${fileName}`);
  
  // Если используем локальный API и файл доступен локально - просто копируем его
  if (useLocalApi && file.file_path && (file.file_path.startsWith('/') || file.file_path.startsWith('\\'))) {
    try {
      console.log(`Local API mode: checking if file exists at ${file.file_path}`);
      // Проверяем существование файла
      await fs.access(file.file_path);
      
      console.log(`Local file found! Copying to ${localPath}`);
      await fs.copyFile(file.file_path, localPath);
      return localPath;
    } catch (e) {
      console.log(`Local file check failed: ${e instanceof Error ? e.message : String(e)}. Falling back to HTTP download.`);
    }
  }
  
  // Используем getFileLink() для получения правильного URL (учитывает локальный сервер)
  let fileUrl: string;
  try {
    fileUrl = await bot.getFileLink(fileId);
  } catch (e) {
    // Fallback если getFileLink не сработал
    const baseUrl = useLocalApi 
      ? (process.env.LOCAL_API_URL || 'http://localhost:8081') 
      : 'https://api.telegram.org';
    fileUrl = `${baseUrl}/file/bot${token}/${file.file_path}`;
  }

  console.log(`Downloading: ${fileName} from ${fileUrl}`);
  
  try {
    await downloadFileWithRetry(fileUrl, localPath);
    return localPath;
  } catch (error) {
    // Финальная очистка при ошибке
    await cleanupIncompleteFile(localPath);
    
    console.error('Download error:', error);
    
    let errorMsg = 'Failed to download file';
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      
      if (msg.includes('econnreset') || msg.includes('socket hang up')) {
        errorMsg = 'Соединение разорвано. Попробуйте отправить файл снова или используйте файл меньшего размера.';
      } else if (msg.includes('timeout') || msg.includes('etimedout')) {
        errorMsg = 'Превышено время ожидания. Файл слишком большой или медленное соединение.';
      } else if (msg.includes('enotfound') || msg.includes('dns')) {
        errorMsg = 'Ошибка сети. Проверьте интернет-соединение.';
      } else if (msg.includes('econnrefused')) {
        errorMsg = 'Не удалось подключиться к серверу Telegram.';
      } else if (msg.includes('too large') || msg.includes('size')) {
        errorMsg = 'Файл слишком большой. Максимальный размер: 500MB.';
      } else if (msg.includes('http 4') || msg.includes('http 5')) {
        errorMsg = `Ошибка сервера Telegram: ${error.message}`;
      } else {
        errorMsg = error.message;
      }
    } else if (typeof error === 'object' && error !== null) {
      const err = error as any;
      if (err.response) {
        errorMsg = `Telegram API error: ${JSON.stringify(err.response.body || err.response)}`;
      } else if (err.description) {
        errorMsg = err.description;
      } else if (err.message) {
        errorMsg = err.message;
      }
    }
    
    throw new Error(errorMsg);
  }
}

// Очистка файлов
export async function cleanupFiles(filePaths: string[]) {
  for (const filePath of filePaths) {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      console.warn(`Failed to delete file ${filePath}:`, error);
    }
  }
}
