import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel (женский голос, подходит для новостей)

interface AudioSegment {
  text: string;
  startTime: number; // секунды от начала видео
  duration: number; // длительность сегмента
  audioPath: string; // путь к файлу аудио
}

/**
 * Озвучивает текст через ElevenLabs API
 */
export async function generateSpeech(text: string, outputPath: string): Promise<void> {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY не найден в .env');
  }

  if (!text || text.trim().length === 0) {
    throw new Error('Текст для озвучки пуст');
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key': ELEVENLABS_API_KEY
    },
    body: JSON.stringify({
      text: text.trim(),
      model_id: 'eleven_multilingual_v2', // Поддержка русского языка
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
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
    // Сначала получаем длительность исходного аудио
    const probe = spawn(ffmpegPath || 'ffmpeg', [
      '-i', inputPath,
      '-show_entries', 'format=duration',
      '-v', 'quiet',
      '-of', 'csv=p=0'
    ]);

    let duration = '';
    probe.stdout.on('data', (data) => {
      duration += data.toString();
    });

    probe.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error('Failed to probe audio duration'));
      }

      const originalDuration = parseFloat(duration.trim());
      if (isNaN(originalDuration) || originalDuration <= 0) {
        return reject(new Error(`Invalid audio duration: ${duration}`));
      }

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
          reject(new Error(`FFmpeg failed: ${code}\n${stderr}`));
        }
      });

      ffmpeg.on('error', (err) => {
        reject(err);
      });
    });

    probe.on('error', (err) => {
      reject(err);
    });
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
  headerDuration: number, // 4 секунды
  tickerDuration: number, // ~8.67 секунды каждый
  totalDuration: number // 35 секунд (30 контент + 5 CTA)
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
      
      // Генерируем речь
      await generateSpeech(ticker, audioPath);
      
      // Настраиваем скорость под нужную длительность
      await adjustAudioSpeed(audioPath, tickerDuration, trimmedPath);
      
      // Вычисляем время начала этого сегмента
      const startTime = headerDuration + (i * tickerDuration);
      
      segments.push({
        path: trimmedPath,
        startTime,
        duration: tickerDuration
      });

      // Удаляем исходный файл
      await fs.unlink(audioPath).catch(() => {});
      
    } catch (error) {
      console.error(`[ElevenLabs] Ошибка при озвучке ticker ${i + 1}:`, error);
      // Продолжаем с другими ticker'ами
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

