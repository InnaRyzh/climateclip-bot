import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import path from 'path';
import fs from 'fs/promises';

// Устанавливаем путь к ffmpeg
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

export async function convertWebmToMp4(inputPath: string): Promise<string> {
  const outputPath = inputPath.replace('.webm', '.mp4');
  
  console.log(`Starting conversion: ${inputPath} -> ${outputPath}`);
  
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v libx264',     // Видео кодек H.264
        '-qp 0',            // Lossless режим (без потери качества)
        '-preset veryslow', // Максимальное качество
        '-vf scale=1080:1920,setsar=1:1', // Масштабирование
        '-r 30',             // Принудительно 30 fps
        '-vsync cfr',        // Постоянная частота кадров (лечит растягивание)
        '-aspect 9:16',      // Соотношение сторон
        '-c:a copy',        // Копируем аудио без перекодирования (было aac 192k)
        '-movflags +faststart', // Для стриминга (быстрый старт)
        '-pix_fmt yuv420p'   // Для совместимости с плеерами (QuickTime и др.)
      ])
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

