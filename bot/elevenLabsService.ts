import fs from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ElevenLabs TTS API настройки
// ВАЖНО: API ключ должен быть установлен через переменную окружения ELEVENLABS_API_KEY
// Для продакшена на Railway установите переменную окружения ELEVENLABS_API_KEY
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'sk_fb1ec1e0c207932d4bcb9dfd6dc2bd67713afac1b69e3b99';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'txnCCHHGKmYIwrn7HfHQ';

// Логируем используемый голос для отладки
console.log(`[ElevenLabs] Используется голос ID: ${ELEVENLABS_VOICE_ID}${process.env.ELEVENLABS_VOICE_ID ? ' (из переменной окружения)' : ' (по умолчанию)'}`);

interface AudioSegment {
  text: string;
  startTime: number; // секунды от начала видео
  duration: number; // длительность сегмента
  audioPath: string; // путь к файлу аудио
}

/**
 * Расшифровывает сокращения в тексте для правильной начитки
 */
function expandAbbreviations(text: string): string {
  let expanded = text;
  
  // Словарь сокращений и их расшифровок
  const abbreviations: Record<string, string> = {
    'км/ч': 'километров в час',
    'км/час': 'километров в час',
    'мм': 'миллиметров',
    'см': 'сантиметров',
    'м': 'метров',
    'км': 'километров',
    '°C': 'градусов по Цельсию',
    '°F': 'градусов по Фаренгейту',
    'м/с': 'метров в секунду',
    'мг/м³': 'миллиграммов на кубический метр',
    '%': 'процентов',
    'млн': 'миллионов',
    'млрд': 'миллиардов',
    'тыс': 'тысяч',
    'г': 'граммов',
    'кг': 'килограммов',
    'т': 'тонн',
    'л': 'литров',
    'мл': 'миллилитров',
    'ч': 'часов',
    'мин': 'минут',
    'сек': 'секунд',
    'дн': 'дней',
    'нед': 'недель',
    'мес': 'месяцев',
    'г': 'годов',
    'гг': 'годов',
    'д.н.э.': 'до нашей эры',
    'н.э.': 'нашей эры',
    'т.д.': 'так далее',
    'т.п.': 'тому подобное',
    'т.е.': 'то есть',
    'т.к.': 'так как',
    'и т.д.': 'и так далее',
    'и т.п.': 'и тому подобное',
  };
  
  // Заменяем сокращения (с учётом регистра и границ слов)
  for (const [abbr, expansion] of Object.entries(abbreviations)) {
    // Создаём регулярное выражение для поиска сокращения как отдельного слова
    const regex = new RegExp(`\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    expanded = expanded.replace(regex, expansion);
  }
  
  // Обработка чисел с единицами измерения (например, "50 км/ч" -> "50 километров в час")
  expanded = expanded.replace(/(\d+)\s*км\/ч/gi, '$1 километров в час');
  expanded = expanded.replace(/(\d+)\s*мм/gi, '$1 миллиметров');
  expanded = expanded.replace(/(\d+)\s*см/gi, '$1 сантиметров');
  expanded = expanded.replace(/(\d+)\s*м\b/gi, '$1 метров');
  expanded = expanded.replace(/(\d+)\s*км\b/gi, '$1 километров');
  expanded = expanded.replace(/(\d+)\s*°C/gi, '$1 градусов по Цельсию');
  expanded = expanded.replace(/(\d+)\s*%/gi, '$1 процентов');
  
  return expanded;
}

/**
 * Озвучивает текст через ElevenLabs API
 */
export async function generateSpeech(text: string, outputPath: string): Promise<void> {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY не найден. Установите переменную окружения ELEVENLABS_API_KEY.');
  }

  if (!text || text.trim().length === 0) {
    throw new Error('Текст для озвучки пуст');
  }

  // Расшифровываем сокращения перед отправкой на озвучку
  const expandedText = expandAbbreviations(text.trim());
  
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key': ELEVENLABS_API_KEY
    },
    body: JSON.stringify({
      text: expandedText,
      model_id: 'eleven_multilingual_v2', // Поддержка русского языка
      voice_settings: {
        // Чуть более информативная подача «новостного» стиля
        stability: 0.5,
        similarity_boost: 0.78,
        style: 0.2,
        use_speaker_boost: true
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage = `ElevenLabs API error: ${response.status}`;
    
    try {
      const errorJson = JSON.parse(errorText);
      if (errorJson.detail?.status === 'missing_permissions') {
        errorMessage = `Ошибка прав доступа: API ключ не имеет разрешения 'text_to_speech'. 
Проверьте настройки ключа в https://elevenlabs.io/app/settings/api-key
Убедитесь, что у ключа включено разрешение "Text to Speech".`;
      } else if (errorJson.detail?.message) {
        const detailMsg = errorJson.detail.message;
        if (detailMsg.includes('Free Tier usage disabled') || detailMsg.includes('Unusual activity')) {
          errorMessage = `ElevenLabs заблокировал Free Tier из-за необычной активности.
Для работы озвучки необходим Paid Plan на ElevenLabs.
Видео будет отправлено без озвучки.`;
        } else {
          errorMessage = `ElevenLabs API: ${detailMsg}`;
        }
      } else {
        errorMessage = `ElevenLabs API error: ${errorText}`;
      }
    } catch {
      errorMessage = `ElevenLabs API error: ${response.status} - ${errorText}`;
    }
    
    throw new Error(errorMessage);
  }

  const audioBuffer = await response.arrayBuffer();
  await fs.writeFile(outputPath, Buffer.from(audioBuffer));
}

/**
 * Нарезает аудио под нужную длительность (ускоряет/замедляет или обрезает)
 */
export async function trimAudioToDuration(
  inputPath: string,
  targetDuration: number,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath || 'ffmpeg', [
      '-y',
      '-i', inputPath,
      '-t', targetDuration.toString(),
      '-af', `atempo=1.0`, // Можно ускорить/замедлить через atempo
      '-acodec', 'aac',
      '-ar', '44100',
      '-b:a', '128k',
      outputPath
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg failed: ${code}\n${stderr}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Ускоряет или замедляет аудио для точного попадания в тайминг
 */
export async function adjustAudioSpeed(
  inputPath: string,
  targetDuration: number,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Используем ffprobe для получения длительности (более надёжно)
    // Если ffprobe недоступен, используем ffmpeg с правильными параметрами
    const probeCmd = ffmpegPath?.replace('ffmpeg', 'ffprobe') || 'ffprobe';
    
    const probe = spawn(probeCmd, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let duration = '';
    let probeStderr = '';
    
    probe.stdout.on('data', (data) => {
      duration += data.toString();
    });
    
    probe.stderr.on('data', (data) => {
      probeStderr += data.toString();
    });

    probe.on('close', (code) => {
      if (code !== 0) {
        // Если ffprobe не работает, пробуем через ffmpeg
        console.warn('[Audio] ffprobe failed, trying ffmpeg method...');
        const ffmpegProbe = spawn(ffmpegPath || 'ffmpeg', [
          '-i', inputPath,
          '-f', 'null',
          '-'
        ], {
          stdio: ['ignore', 'ignore', 'pipe']
        });
        
        let ffmpegStderr = '';
        ffmpegProbe.stderr.on('data', (data) => {
          const text = data.toString();
          ffmpegStderr += text;
          // Ищем длительность в выводе ffmpeg: Duration: HH:MM:SS.mm
          const durationMatch = text.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
          if (durationMatch) {
            const hours = parseInt(durationMatch[1]);
            const minutes = parseInt(durationMatch[2]);
            const seconds = parseInt(durationMatch[3]);
            const centiseconds = parseInt(durationMatch[4]);
            duration = (hours * 3600 + minutes * 60 + seconds + centiseconds / 100).toString();
          }
        });
        
        ffmpegProbe.on('close', (ffmpegCode) => {
          const originalDuration = parseFloat(duration.trim());
          if (isNaN(originalDuration) || originalDuration <= 0) {
            return reject(new Error(`Failed to get audio duration. ffprobe stderr: ${probeStderr}, ffmpeg stderr: ${ffmpegStderr.substring(0, 200)}`));
          }
          
          processAudioSpeed(inputPath, originalDuration, targetDuration, outputPath, resolve, reject);
        });
        
        ffmpegProbe.on('error', (err) => {
          reject(new Error(`Failed to probe audio: ${err.message}`));
        });
        
        return;
      }

      const originalDuration = parseFloat(duration.trim());
      if (isNaN(originalDuration) || originalDuration <= 0) {
        return reject(new Error(`Invalid audio duration: ${duration.trim()}`));
      }

      processAudioSpeed(inputPath, originalDuration, targetDuration, outputPath, resolve, reject);
    });

    probe.on('error', (err) => {
      // Если ffprobe не найден, пробуем через ffmpeg
      console.warn('[Audio] ffprobe not found, using ffmpeg method...');
      const ffmpegProbe = spawn(ffmpegPath || 'ffmpeg', [
        '-i', inputPath,
        '-f', 'null',
        '-'
      ], {
        stdio: ['ignore', 'ignore', 'pipe']
      });
      
      let ffmpegStderr = '';
      ffmpegProbe.stderr.on('data', (data) => {
        const text = data.toString();
        ffmpegStderr += text;
        const durationMatch = text.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (durationMatch) {
          const hours = parseInt(durationMatch[1]);
          const minutes = parseInt(durationMatch[2]);
          const seconds = parseInt(durationMatch[3]);
          const centiseconds = parseInt(durationMatch[4]);
          duration = (hours * 3600 + minutes * 60 + seconds + centiseconds / 100).toString();
        }
      });
      
      ffmpegProbe.on('close', () => {
        const originalDuration = parseFloat(duration.trim());
        if (isNaN(originalDuration) || originalDuration <= 0) {
          return reject(new Error(`Failed to get audio duration from ffmpeg output`));
        }
        processAudioSpeed(inputPath, originalDuration, targetDuration, outputPath, resolve, reject);
      });
      
      ffmpegProbe.on('error', (probeErr) => {
        reject(new Error(`Failed to probe audio: ${probeErr.message}`));
      });
    });
  });
}

function processAudioSpeed(
  inputPath: string,
  originalDuration: number,
  targetDuration: number,
  outputPath: string,
  resolve: () => void,
  reject: (err: Error) => void
) {
  // Вычисляем коэффициент скорости (tempo)
  // atempo принимает значения от 0.5 до 2.0, если нужно больше - применяем несколько раз
  let speed = originalDuration / targetDuration;
  
  const ffmpeg = spawn(ffmpegPath || 'ffmpeg', [
    '-y',
    '-i', inputPath,
    '-af', getTempoFilter(speed),
    '-acodec', 'aac',
    '-ar', '44100',
    '-b:a', '128k',
    outputPath
  ]);

  let stderr = '';
  ffmpeg.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  ffmpeg.on('close', (code) => {
    if (code === 0) {
      resolve();
    } else {
      reject(new Error(`FFmpeg failed: ${code}\n${stderr.substring(0, 500)}`));
    }
  });

  ffmpeg.on('error', (err) => {
    reject(err);
  });
}

/**
 * Генерирует фильтр atempo для FFmpeg (поддерживает значения > 2.0 через цепочку)
 */
function getTempoFilter(speed: number): string {
  if (speed <= 0.5) {
    return 'atempo=0.5';
  }
  if (speed <= 1.0) {
    return `atempo=${speed}`;
  }
  if (speed <= 2.0) {
    return `atempo=${speed}`;
  }
  // Для speed > 2.0 применяем цепочку: atempo=2.0,atempo=...
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2.0) {
    filters.push('atempo=2.0');
    remaining /= 2.0;
  }
  if (remaining > 1.0) {
    filters.push(`atempo=${remaining}`);
  }
  return filters.join(',');
}

/**
 * Объединяет несколько аудио файлов в один с паузами между ними
 */
export async function concatenateAudioSegments(
  segments: Array<{ path: string; startTime: number; duration: number }>,
  totalDuration: number,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Создаём временный файл со списком для concat
    const tempDir = path.join(__dirname, 'temp');
    const concatListPath = path.join(tempDir, `concat_${Date.now()}.txt`);
    
    // Создаём аудио с тишиной для пауз
    const createSilence = async (duration: number, output: string): Promise<void> => {
      return new Promise((resolveSilence, rejectSilence) => {
        const ffmpeg = spawn(ffmpegPath || 'ffmpeg', [
          '-y',
          '-f', 'lavfi',
          '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`,
          '-t', duration.toString(),
          '-acodec', 'aac',
          output
        ]);

        ffmpeg.on('close', (code) => {
          if (code === 0) resolveSilence();
          else rejectSilence(new Error(`Failed to create silence: ${code}`));
        });

        ffmpeg.on('error', rejectSilence);
      });
    };

    // Строим последовательность: тишина до первого сегмента, затем сегменты с паузами
    const buildAudioSequence = async (): Promise<string[]> => {
      const tempFiles: string[] = [];
      
      // Тишина до первого сегмента
      if (segments.length > 0 && segments[0].startTime > 0) {
        const silencePath = path.join(tempDir, `silence_start_${Date.now()}.aac`);
        await createSilence(segments[0].startTime, silencePath);
        tempFiles.push(silencePath);
      }

      // Сегменты с паузами между ними
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        tempFiles.push(seg.path);

        // Пауза до следующего сегмента
        if (i < segments.length - 1) {
          const nextSeg = segments[i + 1];
          const pauseDuration = nextSeg.startTime - (seg.startTime + seg.duration);
          if (pauseDuration > 0) {
            const silencePath = path.join(tempDir, `silence_${i}_${Date.now()}.aac`);
            await createSilence(pauseDuration, silencePath);
            tempFiles.push(silencePath);
          }
        }
      }

      // Тишина в конце до totalDuration
      if (segments.length > 0) {
        const lastSeg = segments[segments.length - 1];
        const endTime = lastSeg.startTime + lastSeg.duration;
        if (endTime < totalDuration) {
          const silencePath = path.join(tempDir, `silence_end_${Date.now()}.aac`);
          await createSilence(totalDuration - endTime, silencePath);
          tempFiles.push(silencePath);
        }
      }

      return tempFiles;
    };

    buildAudioSequence()
      .then(async (tempFiles) => {
        // Создаём файл списка для concat
        const concatLines = tempFiles.map(f => `file '${f}'`).join('\n');
        await fs.writeFile(concatListPath, concatLines);

        // Объединяем через concat demuxer
        const ffmpeg = spawn(ffmpegPath || 'ffmpeg', [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', concatListPath,
          '-t', totalDuration.toString(),
          '-acodec', 'aac',
          '-ar', '44100',
          '-b:a', '128k',
          outputPath
        ]);

        let stderr = '';
        ffmpeg.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        ffmpeg.on('close', async (code) => {
          // Очищаем временные файлы
          try {
            await Promise.all([
              ...tempFiles.map(f => fs.unlink(f).catch(() => {})),
              fs.unlink(concatListPath).catch(() => {})
            ]);
          } catch (e) {
            console.warn('Failed to cleanup temp audio files:', e);
          }

          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`FFmpeg concat failed: ${code}\n${stderr}`));
          }
        });

        ffmpeg.on('error', (err) => {
          reject(err);
        });
      })
      .catch(reject);
  });
}

/**
 * Основная функция: озвучивает все ticker'ы и создаёт финальный аудио трек
 */
export async function generateNewsAudioTrack(
  tickers: string[],
  initialSilence: number, // 2 секунды тишины в начале
  tickerDuration: number, // ~9.33 секунды каждый
  totalDuration: number, // 37 секунд (30 контент + 7 CTA)
  ctaText?: string // Текст для CTA (призыва к действию)
): Promise<string> {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY не найден в .env');
  }

  const tempDir = path.join(__dirname, 'temp', 'audio');
  await fs.mkdir(tempDir, { recursive: true });

  const segments: Array<{ path: string; startTime: number; duration: number }> = [];

  // Озвучиваем каждый ticker
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    if (!ticker || ticker.trim().length === 0) continue;

    const audioPath = path.join(tempDir, `ticker_${i}_${Date.now()}.mp3`);
    const trimmedPath = path.join(tempDir, `ticker_${i}_trimmed_${Date.now()}.aac`);

    try {
      console.log(`[ElevenLabs] Озвучиваю ticker ${i + 1}/${tickers.length}: "${ticker.substring(0, 50)}..."`);
      
      // Добавляем небольшую задержку между запросами
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 500)); // 0.5 секунды задержка
      }
      
      // Генерируем речь через ElevenLabs
      await generateSpeech(ticker, audioPath);
      
      // Настраиваем скорость под нужную длительность (полная длительность, без задержки)
      await adjustAudioSpeed(audioPath, tickerDuration, trimmedPath);
      
      // Вычисляем время начала этого сегмента: начитка начинается со 2 секунды вместе с текстом
      // Первые 2 секунды - тишина (пользователь может перелистнуть)
      const audioStartTime = initialSilence + (i * tickerDuration); // 2 + i * tickerDuration
      
      segments.push({
        path: trimmedPath,
        startTime: audioStartTime,
        duration: tickerDuration
      });

      // Удаляем исходный файл
      await fs.unlink(audioPath).catch(() => {});
      
    } catch (error) {
      console.error(`[ElevenLabs] Ошибка при озвучке ticker ${i + 1}:`, error);
      // Продолжаем с другими ticker'ами
    }
  }

  // --- Кэширование CTA озвучки, чтобы не тратить кредиты на неизменяемый текст ---
  const cacheDir = path.join(__dirname, 'temp', 'audio_cache');
  await fs.mkdir(cacheDir, { recursive: true });

  const getCachedCtaAudio = async (text: string): Promise<{ path: string; fromCache: boolean }> => {
    const normalized = text.trim();
    const hash = createHash('sha1')
      .update(normalized + ELEVENLABS_VOICE_ID)
      .digest('hex');
    const cachedPath = path.join(cacheDir, `cta_${hash}.mp3`);
    try {
      await fs.access(cachedPath);
      console.log(`[ElevenLabs] CTA из кэша: ${cachedPath}`);
      return { path: cachedPath, fromCache: true };
    } catch {
      // not cached
    }
    const tmpPath = path.join(cacheDir, `cta_${hash}_tmp.mp3`);
    await generateSpeech(normalized, tmpPath);
    await fs.rename(tmpPath, cachedPath);
    console.log(`[ElevenLabs] CTA сохранён в кэш: ${cachedPath}`);
    return { path: cachedPath, fromCache: false };
  };

  // Озвучиваем CTA текст, если он предоставлен
  if (ctaText && ctaText.trim().length > 0) {
    const { path: ctaAudioPath, fromCache } = await getCachedCtaAudio(ctaText);
    const ctaTrimmedPath = path.join(tempDir, `cta_trimmed_${Date.now()}.aac`);
    const CTA_DURATION = 8; // Длительность CTA секции
    const CTA_SPEED = 1.1;  // Ускорение начитки для CTA

    try {
      if (!fromCache) {
        console.log(`[ElevenLabs] Озвучиваю CTA: "${ctaText.substring(0, 50)}..."`);
      }
      
      // Настраиваем скорость: чуть ускоряем (1.1x), затем подгоняем под 7 секунд
      const targetDuration = CTA_DURATION / CTA_SPEED; // чтобы после ускорения уложиться в 7с
      await adjustAudioSpeed(ctaAudioPath, targetDuration, ctaTrimmedPath);
      
      // CTA начинается после всех ticker'ов (30 секунда)
      const ctaStartTime = initialSilence + (tickers.length * tickerDuration); // 2 + 3 * 9.33 = 30
      
      segments.push({
        path: ctaTrimmedPath,
        startTime: ctaStartTime,
        duration: CTA_DURATION
      });

      // Кэшированный файл не трогаем; временный (если был) уже переименован в кэш
      
    } catch (error) {
      console.error(`[ElevenLabs] Ошибка при озвучке CTA:`, error);
      // Продолжаем без CTA начитки
    }
  }

  if (segments.length === 0) {
    throw new Error('Не удалось озвучить ни один ticker');
  }

  // Объединяем все сегменты в один трек
  const outputPath = path.join(tempDir, `news_audio_${Date.now()}.aac`);
  await concatenateAudioSegments(segments, totalDuration, outputPath);

  // Очищаем промежуточные файлы
  for (const seg of segments) {
    await fs.unlink(seg.path).catch(() => {});
  }

  return outputPath;
}

