// Адаптер для использования существующей логики compositor.ts на сервере
// Использует Puppeteer для выполнения Canvas API кода

import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface GridRenderData {
  videos: string[];
  countries: string[];
  date: string;
}

interface NewsRenderData {
  videos: string[];
  country: string;
  date: string;
  tickers: string[];
}

export async function renderGridVideo(data: GridRenderData): Promise<string> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920 });

    // Создаем HTML страницу с рендерером
    const htmlContent = await createRendererHTML('grid', data);
    await page.setContent(htmlContent);
    
    // Ждем загрузки всех видео
    await page.waitForFunction(() => {
      // @ts-ignore
      return window.videosLoaded === true;
    }, { timeout: 60000 });

    // Запускаем рендеринг
    const outputPath = path.join(__dirname, '../temp', `grid_${Date.now()}.webm`);
    
    await page.evaluate(async (outputPath) => {
      // @ts-ignore
      const blob = await window.renderGridVideo();
      
      // Конвертируем blob в base64 и сохраняем
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = () => {
        // @ts-ignore
        window.videoData = reader.result;
      };
    }, outputPath);

    // Ждем завершения рендеринга
    await page.waitForFunction(() => {
      // @ts-ignore
      return window.videoData !== undefined;
    }, { timeout: 120000 });

    const videoData = await page.evaluate(() => {
      // @ts-ignore
      return window.videoData;
    });

    // Сохраняем видео
    if (videoData && typeof videoData === 'string') {
      const base64Data = videoData.split(',')[1];
      const buffer = Buffer.from(base64Data, 'base64');
      await fs.writeFile(outputPath, buffer);
      return outputPath;
    }

    throw new Error('Не удалось получить видео данные');
  } finally {
    await browser.close();
  }
}

export async function renderNewsVideo(data: NewsRenderData): Promise<string> {
  // Аналогично renderGridVideo
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920 });

    const htmlContent = await createRendererHTML('news', data);
    await page.setContent(htmlContent);
    
    await page.waitForFunction(() => {
      // @ts-ignore
      return window.videosLoaded === true;
    }, { timeout: 60000 });

    const outputPath = path.join(__dirname, '../temp', `news_${Date.now()}.webm`);
    
    await page.evaluate(async () => {
      // @ts-ignore
      const blob = await window.renderNewsVideo();
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = () => {
        // @ts-ignore
        window.videoData = reader.result;
      };
    });

    await page.waitForFunction(() => {
      // @ts-ignore
      return window.videoData !== undefined;
    }, { timeout: 120000 });

    const videoData = await page.evaluate(() => {
      // @ts-ignore
      return window.videoData;
    });

    if (videoData && typeof videoData === 'string') {
      const base64Data = videoData.split(',')[1];
      const buffer = Buffer.from(base64Data, 'base64');
      await fs.writeFile(outputPath, buffer);
      return outputPath;
    }

    throw new Error('Не удалось получить видео данные');
  } finally {
    await browser.close();
  }
}

async function createRendererHTML(template: string, data: any): Promise<string> {
  // Читаем существующий compositor код
  const compositorCode = await fs.readFile(
    path.join(__dirname, '../services/compositor.ts'),
    'utf-8'
  );

  // Создаем HTML страницу с рендерером
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body>
  <script>
    // Импортируем функции из compositor (упрощенная версия)
    // Здесь нужно будет адаптировать код для работы в браузере
    
    const data = ${JSON.stringify(data)};
    const template = '${template}';
    
    // Загружаем видео
    window.videosLoaded = false;
    window.videoData = undefined;
    
    async function loadVideos() {
      // Загружаем видео файлы
      // ...
      window.videosLoaded = true;
    }
    
    async function renderGridVideo() {
      // Используем существующую логику из compositor.ts
      // ...
      return blob;
    }
    
    async function renderNewsVideo() {
      // Используем существующую логику из compositor.ts
      // ...
      return blob;
    }
    
    loadVideos();
  </script>
</body>
</html>
  `;
}


