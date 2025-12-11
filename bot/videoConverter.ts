import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import path from 'path';
import fs from 'fs/promises';

// Устанавливаем путь к ffmpeg
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

export async function convertWebmToMp4(inputPath: string, outputFileName?: string): Promise<string> {
  const outputPath = outputFileName 
    ? path.join(path.dirname(inputPath), outputFileName)
    : inputPath.replace('.webm', '.mp4');
  
  console.log(`Starting conversion: ${inputPath} -> ${outputPath}`);
  
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v libx264',     // Видео кодек H.264
        '-crf 16',          // Почти без сжатия (ниже — меньше компрессия)
        '-preset slow',     // Баланс скорости и качества
        '-vf scale=1080:1920,setsar=1:1', // Масштабирование
        '-r 60',             // Принудительно 60 fps
        '-vsync cfr',        // Постоянная частота кадров (лечит растягивание)
        '-aspect 9:16',      // Соотношение сторон
        '-c:a aac',         // Аудио кодек AAC
        '-b:a 192k',         // Битрейт аудио (высокое качество)
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

