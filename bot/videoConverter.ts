import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import path from 'path';
import fs from 'fs/promises';

// Устанавливаем путь к ffmpeg
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

export async function convertWebmToMp4(
  inputPath: string,
  outputFileName?: string,
  fps?: number
): Promise<string> {
  const outputPath = outputFileName 
    ? path.join(path.dirname(inputPath), outputFileName)
    : inputPath.replace('.webm', '.mp4');
  
  console.log(`Starting conversion: ${inputPath} -> ${outputPath}`);
  
  return new Promise((resolve, reject) => {
    const outputOpts = [
      '-c:v libx264',     // Видео кодек H.264
      '-crf 16',          // Почти без сжатия (ниже — меньше компрессия)
      '-preset slow',     // Баланс скорости и качества
      '-vf scale=1080:1920,setsar=1:1', // Масштабирование
      '-vsync cfr',        // Постоянная частота кадров
      '-aspect 9:16',      // Соотношение сторон
      '-c:a aac',         // Аудио кодек AAC
      '-b:a 192k',         // Битрейт аудио (высокое качество)
      '-movflags +faststart', // Для стриминга (быстрый старт)
      '-pix_fmt yuv420p'   // Для совместимости с плеерами (QuickTime и др.)
    ];

    if (fps && fps > 0) {
      // Форсируем итоговый FPS и GOP для стабильного каденса (без B-frames)
      outputOpts.push(`-r ${fps}`);
      outputOpts.push(`-g ${fps * 2}`);
      outputOpts.push(`-bf 0`);
    }

    ffmpeg(inputPath)
      .outputOptions(outputOpts)
      .on('start', (commandLine) => {
        console.log('FFmpeg process started:', commandLine);
      })
      .on('progress', (progress) => {
        // console.log('Processing: ' + progress.percent + '% done');
      })
      .on('error', (err) => {
        console.error('An error occurred: ' + err.message);
        reject(err);
      })
      .on('end', () => {
        console.log('Conversion finished successfully');
        resolve(outputPath);
      })
      .save(outputPath);
  });
}

/**
 * Добавляет аудио трек к видео (заменяет или смешивает с существующим)
 */
export async function addAudioToVideo(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  mixWithOriginal: boolean = false // Если true - смешивает с оригинальным аудио, иначе заменяет
): Promise<string> {
  console.log(`Adding audio to video: ${videoPath} + ${audioPath} -> ${outputPath}`);
  
  return new Promise((resolve, reject) => {
    const outputOpts = [
      '-c:v copy', // Копируем видео без перекодирования
      '-c:a aac',
      '-b:a 192k',
      '-shortest', // Обрезаем по самому короткому потоку
      '-movflags +faststart'
    ];

    if (mixWithOriginal) {
      // Смешиваем оригинальное аудио с новым (50/50)
      outputOpts.push('-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2');
      outputOpts.push('-map', '0:v:0');
    } else {
      // Заменяем аудио (или добавляем, если его нет)
      // Используем -map для явного указания потоков
      outputOpts.push('-map', '0:v:0');
      // Если в видео есть аудио, оно будет проигнорировано, используем только новое
      outputOpts.push('-map', '1:a:0');
      // Игнорируем оригинальное аудио, если оно есть
      outputOpts.push('-ignore_unknown');
    }

    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions(outputOpts)
      .on('start', (commandLine) => {
        console.log('FFmpeg add audio started:', commandLine);
      })
      .on('error', (err) => {
        console.error('FFmpeg add audio error:', err.message);
        reject(err);
      })
      .on('end', () => {
        console.log('Audio added successfully');
        resolve(outputPath);
      })
      .save(outputPath);
  });
}

