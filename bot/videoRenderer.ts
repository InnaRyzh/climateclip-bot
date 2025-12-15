import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RenderOptions {
  template: 'grid' | 'news';
  videos: string[];
  countries?: string[];
  date?: string;
  country?: string;
  tickers?: string[];
  ctaImageUrl?: string;
  renderMode?: 'realtime' | 'snapshot';
}

// Копируем видео в доступную для браузера директорию
async function prepareVideosForBrowser(videoPaths: string[], serverPort: number): Promise<string[]> {
  const browserVideoDir = path.join(__dirname, 'temp', 'browser_videos');
  await fs.mkdir(browserVideoDir, { recursive: true });
  
  const browserVideoUrls: string[] = [];
  
  for (let i = 0; i < videoPaths.length; i++) {
    const originalPath = videoPaths[i];
    const ext = path.extname(originalPath);
    const fileName = `video_${Date.now()}_${i}${ext}`;
    const browserPath = path.join(browserVideoDir, fileName);
    
    await fs.copyFile(originalPath, browserPath);
    const httpUrl = `http://localhost:${serverPort}/temp/browser_videos/${fileName}`;
    browserVideoUrls.push(httpUrl);
  }
  
  return browserVideoUrls;
}

async function createRendererPage(options: RenderOptions, videoUrls: string[], uploadUrl: string, serverPort: number): Promise<string> {
  const serializedOptions = JSON.stringify(options);
  const serializedVideoUrls = JSON.stringify(videoUrls);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    @font-face {
      font-family: 'Benzin-Bold';
      src: url('http://localhost:${serverPort}/assets/fonts/benzin-bold.ttf') format('truetype');
      font-weight: bold;
      font-style: normal;
      font-display: block;
    }
    body { margin: 0; padding: 0; background: black; overflow: hidden; width: 1080px; height: 1920px; }
    canvas { display: block; width: 1080px; height: 1920px; }
  </style>
</head>
<body>
  <canvas id="canvas" width="1080" height="1920"></canvas>
  <script>
    // Параметры рендера приходят сверху — определяем их до использования
    const options = ${serializedOptions};
    const videoUrls = ${serializedVideoUrls};
    const uploadUrl = "${uploadUrl}";
    const renderMode = options.renderMode || 'realtime';

    // Единое разрешение 1080x1920 для сохранения пропорций текста/элементов
    const WIDTH = 1080;
    const HEIGHT = 1920;
    const FPS_GRID = 30; // менее ресурсоёмко, снижает дропы кадров
    const FPS_NEWS = 60;
    const FPS = options.template === 'grid' ? FPS_GRID : FPS_NEWS;
    
    // --- TIMING CONFIG ---
    const GRID_CONTENT_DURATION = 20; 
    const NEWS_INITIAL_SILENCE = 2; // Тишина в начале (пользователь может перелистнуть)
    const NEWS_HEADER_DURATION = 2; // секунды показа шапки (дата+страна) - первые 2 секунды
    const NEWS_TICKER_COUNT = 3; // количество текстовых блоков от Perplexity
    const NEWS_CLIP_DURATION = 6; // длительность каждого ролика
    const NEWS_CLIP_COUNT = 5; // количество роликов
    const CTA_DURATION = 7; // призыв к действию (увеличено на 2 секунды)
    // Вычисляем длительность каждого текстового блока:
    // Всего видео: 5 роликов * 6 сек = 30 сек + CTA 7 сек = 37 сек
    // Контент до CTA: 37 - 7 = 30 сек
    // После начальной тишины (2 сек): 30 - 2 = 28 сек
    // На 3 блока: 28 / 3 = 9.33 сек каждый
    const NEWS_TICKER_DURATION = (NEWS_CLIP_COUNT * NEWS_CLIP_DURATION + CTA_DURATION - NEWS_INITIAL_SILENCE - CTA_DURATION) / NEWS_TICKER_COUNT;
    const NEWS_CONTENT_DURATION = NEWS_INITIAL_SILENCE + NEWS_TICKER_DURATION * NEWS_TICKER_COUNT; // 2 + 28 = 30 сек 
    
    window.videosLoaded = false;
    window.uploadComplete = false;
    window.renderError = undefined;

    // --- UTILS ---

    const toTitleCase = (str) => {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
    };

    const formatCountry = (str) => {
        if (!str) return '';
        return str
          .split(' ')
          .map(w => w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : '')
          .join(' ');
    };

    // Для новостного шаблона выводим страну в верхнем регистре
    const formatCountryNews = (str) => {
        if (!str) return '';
        return str.toUpperCase();
    };

    const formatDate = (dateStr) => {
        if (!dateStr) return '';
        return dateStr.replace(/\\b([А-ЯЁ]+)\\b/g, (match) => {
            if (match === match.toUpperCase() && match.length > 2) {
                return match.charAt(0) + match.slice(1).toLowerCase();
            }
            return match;
        });
    };

    const getMimeType = () => {
      const types = [
        'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
        'video/mp4',
        'video/webm; codecs=h264',
        'video/webm; codecs=vp9', 
        'video/webm'
      ];
      for (const t of types) {
        if (MediaRecorder.isTypeSupported(t)) return t;
      }
      return 'video/webm';
    };

    const loadVideo = (src) => {
      return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.src = src;
        video.crossOrigin = 'anonymous';
        video.muted = true; // по умолчанию выключаем звук для автозапуска
        video.volume = 0;
        video.playsInline = true;
        video.preload = 'auto';
        
        const timeout = setTimeout(() => {
          reject(new Error('Timeout loading video: ' + src));
        }, 60000); 

        const checkReady = () => {
          if (video.readyState >= 2) {
            clearTimeout(timeout);
            resolve(video);
          } else {
            video.addEventListener('loadeddata', () => { clearTimeout(timeout); resolve(video); }, { once: true });
            video.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Error loading video: ' + src)); }, { once: true });
            video.load();
          }
        };
        checkReady();
      });
    };

    const loadImage = (src) => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    };

    const drawVideoCover = (ctx, video, x, y, w, h) => {
      if (video.videoWidth === 0 || video.videoHeight === 0) return;
      
      const videoRatio = video.videoWidth / video.videoHeight;
      const targetRatio = w / h;
      
      let sx, sy, sw, sh;
      let dx, dy, dw, dh;

      // COVER режим: заполняем весь слот, обрезая лишнее
      if (videoRatio > targetRatio) {
        // Видео шире слота - обрезаем по бокам
        sh = video.videoHeight;
        sw = sh * targetRatio;
        sy = 0;
        sx = (video.videoWidth - sw) / 2;
        // Рисуем в полный размер слота
        dx = x;
        dy = y;
        dw = w;
        dh = h;
      } else {
        // Видео выше слота - обрезаем сверху/снизу
        sw = video.videoWidth;
        sh = sw / targetRatio;
        sx = 0;
        sy = (video.videoHeight - sh) / 2;
        // Рисуем в полный размер слота
        dx = x;
        dy = y;
        dw = w;
        dh = h;
      }
      
      // Очищаем область слота черным (на случай, если видео меньше)
      ctx.fillStyle = 'black';
      ctx.fillRect(x, y, w, h);
      
      // Рисуем видео с правильным соотношением сторон (без растяжения)
      ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
    };


    const getLines = (ctx, text, maxWidth) => {
        const words = text.split(" ");
        const lines = [];
        let currentLine = words[0];

        for (let i = 1; i < words.length; i++) {
            const word = words[i];
            const width = ctx.measureText(currentLine + " " + word).width;
            if (width < maxWidth) {
                currentLine += " " + word;
            } else {
                lines.push(currentLine);
                currentLine = word;
            }
        }
        lines.push(currentLine);
        return lines;
    };

    const drawQuoteIcon = (ctx, x, y, size = 60) => {
        ctx.save();
        ctx.fillStyle = '#4ade80';
        ctx.fillRect(x, y, size, size);
        ctx.fillStyle = 'white';
        ctx.font = \`bold \${size}px "Times New Roman", serif\`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('“', x + size/2, y + size/2 + 10);
        ctx.restore();
    };
    
    // Вспомогательная функция для руки
    const drawHandCursorInner = (ctx, x, y, scale = 1.5) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(scale, scale);
        
        ctx.fillStyle = 'white';
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'miter';
        
        ctx.beginPath();
        ctx.moveTo(0, 0);       
        ctx.lineTo(18, 15);      
        ctx.lineTo(10, 15);      
        ctx.lineTo(15, 28);      
        ctx.lineTo(11, 30);      
        ctx.lineTo(6, 16);       
        ctx.lineTo(0, 22);       
        ctx.closePath();
        
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 5;
        
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    };

    const drawImageCTA = (ctx, frameCount, ctaImage) => {
        ctx.fillStyle = '#0f0f12'; 
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        
        // Изображение CTA (если есть)
        const centerX = WIDTH / 2;
        
        let imageY = 300; 
        const imgW = 700; 
        let imgH = 0;
        let imgX = (WIDTH - imgW) / 2;

        if (ctaImage && ctaImage.complete) {
            const imgRatio = ctaImage.width / ctaImage.height;
            imgH = imgW / imgRatio;
            
            // Скругление углов
            const radius = 40; // Увеличено для более красивого скругления
            
            // Рисуем размытую тень для объёма (несколько слоёв для более реалистичного эффекта)
            ctx.save();
            
            // Первый слой тени (большое размытие, дальше)
            ctx.shadowColor = 'rgba(0,0,0,0.4)';
            ctx.shadowBlur = 60;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 30;
            ctx.beginPath();
            ctx.roundRect(imgX, imageY, imgW, imgH, radius);
            ctx.fill();
            
            // Второй слой тени (среднее размытие)
            ctx.shadowColor = 'rgba(0,0,0,0.3)';
            ctx.shadowBlur = 40;
            ctx.shadowOffsetY = 20;
            ctx.beginPath();
            ctx.roundRect(imgX, imageY, imgW, imgH, radius);
            ctx.fill();
            
            // Третий слой тени (близко к изображению)
            ctx.shadowColor = 'rgba(0,0,0,0.2)';
            ctx.shadowBlur = 20;
            ctx.shadowOffsetY = 10;
            ctx.beginPath();
            ctx.roundRect(imgX, imageY, imgW, imgH, radius);
            ctx.fill();
            
            // Рисуем само изображение с обрезкой по скруглённым углам
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;
            ctx.beginPath();
            ctx.roundRect(imgX, imageY, imgW, imgH, radius);
            ctx.clip();
            
            ctx.drawImage(ctaImage, imgX, imageY, imgW, imgH);
            ctx.restore();
        } else {
            imgH = 600; 
            imageY = HEIGHT / 2 - 400;
        }

        // CTA текст в том же стиле, что и текстовые блоки (убираем кавычки и скобки)
        let ctaText = "О причинах учащения природных катастроф и прогнозах на ближайшие годы в последнем обращении Эгона Чалокяна на канале Время правды";
        ctaText = ctaText.replace(/["'«»„"]/g, '').replace(/[\[\]]/g, '').trim();
        
        // Позиционирование как у текстовых блоков (используем другие имена переменных, чтобы избежать конфликта)
        const ctaSafeBottom = HEIGHT - 400;
        const ctaQuoteSize = 50;
        const ctaSafeMarginX = 160;
        const ctaStartX = ctaSafeMarginX;
        
        let ctaFontSize = 32;
        ctx.font = \`bold \${ctaFontSize}px Arial, sans-serif\`;
        const ctaMaxTextW = WIDTH - ctaSafeMarginX * 2 - ctaQuoteSize - 40;
        let ctaLines = getLines(ctx, ctaText, ctaMaxTextW);
        
        // Автоматическое уменьшение шрифта если не влезает
        while (ctaLines.length > 10 && ctaFontSize > 20) {
            ctaFontSize -= 2;
            ctx.font = \`bold \${ctaFontSize}px Arial, sans-serif\`;
            ctaLines = getLines(ctx, ctaText, ctaMaxTextW);
        }
        
        const ctaGap = 2;
        const ctaBoxHeight = ctaFontSize + 4;
        const ctaTotalH = (ctaLines.length * ctaBoxHeight) + ((ctaLines.length - 1) * ctaGap);
        const ctaStartY = ctaSafeBottom - ctaTotalH;
        
        // Рисуем иконку кавычек слева (как у текстовых блоков)
        drawQuoteIcon(ctx, ctaStartX, ctaStartY, ctaQuoteSize);
        
        const ctaTextX = ctaStartX + ctaQuoteSize + 12;
        
        // Разбиваем текст на части для выделения красным "ученых АЛЛАТРА"
        const ctaHighlightPhrase = "учёных АЛЛАТРА";
        const ctaHighlightPhraseUpper = "УЧЁНЫХ АЛЛАТРА";
        
        ctaLines.forEach((ctaLine, ctaI) => {
            const ctaY = ctaStartY + (ctaI * (ctaBoxHeight + ctaGap));
            
            // Проверяем, содержит ли строка фразу для выделения
            const ctaLineUpper = ctaLine.toUpperCase();
            const ctaHasHighlight = ctaLineUpper.includes(ctaHighlightPhraseUpper);
            
            // Измеряем ширину текста для плашки
            const ctaTextW = ctx.measureText(ctaLine).width;
            
            // Рисуем белую плашку
            ctx.fillStyle = 'white';
            ctx.fillRect(ctaTextX, ctaY, ctaTextW + 20, ctaBoxHeight);
            
            // Рисуем текст с выделением красным
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            
            if (ctaHasHighlight) {
                // Разбиваем строку на части до и после выделяемой фразы
                const ctaHighlightIndex = ctaLineUpper.indexOf(ctaHighlightPhraseUpper);
                const ctaBeforeText = ctaLine.substring(0, ctaHighlightIndex);
                const ctaHighlightText = ctaLine.substring(ctaHighlightIndex, ctaHighlightIndex + ctaHighlightPhrase.length);
                const ctaAfterText = ctaLine.substring(ctaHighlightIndex + ctaHighlightPhrase.length);
                
                let ctaCurrentX = ctaTextX + 10;
                
                // Рисуем текст до выделения (черный)
                if (ctaBeforeText) {
                    ctx.fillStyle = 'black';
                    ctx.fillText(ctaBeforeText, ctaCurrentX, ctaY + 2);
                    ctaCurrentX += ctx.measureText(ctaBeforeText).width;
                }
                
                // Рисуем выделенную фразу (красный)
                ctx.fillStyle = '#FF0000';
                ctx.fillText(ctaHighlightText, ctaCurrentX, ctaY + 2);
                ctaCurrentX += ctx.measureText(ctaHighlightText).width;
                
                // Рисуем текст после выделения (черный)
                if (ctaAfterText) {
                    ctx.fillStyle = 'black';
                    ctx.fillText(ctaAfterText, ctaCurrentX, ctaY + 2);
                }
            } else {
                // Обычный черный текст
                ctx.fillStyle = 'black';
                ctx.fillText(ctaLine, ctaTextX + 10, ctaY + 2);
            }
        });
        
        const t = (frameCount % 60) / 60;
        const handOffset = Math.sin(t * Math.PI * 2) * 10;
        
        const handX = imgX + imgW + 20; 
        const handY = imageY + imgH - 50;
        
        ctx.save();
        ctx.translate(handX - handOffset, handY + handOffset);
        ctx.rotate(-Math.PI / 4);
        drawHandCursorInner(ctx, 0, 0, 2.5); 
        ctx.restore();
    };

    async function startRendering() {
        try {
            console.log('Waiting for fonts...');
            try {
                // Проверяем доступность шрифта
                const fontUrl = 'http://localhost:' + ${serverPort} + '/assets/fonts/benzin-bold.ttf';
                console.log('Loading font from:', fontUrl);
                
                // Загружаем несколько размеров, чтобы шрифт гарантированно применился на всех слайдах (в т.ч. крупный заголовок)
                await Promise.all([
                    document.fonts.load('900 48px "Benzin-Bold"'),
                    document.fonts.load('900 60px "Benzin-Bold"'),
                    document.fonts.load('900 90px "Benzin-Bold"')
                ]);
                await document.fonts.ready;
                
                // Проверяем, что шрифт действительно загружен
                const fontCheck = document.fonts.check('900 48px "Benzin-Bold"');
                console.log('Font loaded:', fontCheck ? 'YES' : 'NO');
                if (!fontCheck) {
                    console.warn('WARNING: Benzin-Bold font not available, will use fallback');
                }
            } catch (e) { 
                console.error('Font loading error:', e);
                console.warn('Will continue with fallback font');
            }
            
            console.log('Loading videos...');
            const videos = await Promise.all(videoUrls.map(url => loadVideo(url)));
            window.videosLoaded = true;
            console.log('Videos loaded!');
            
            // НАСТРОЙКА ЗВУКА (только для news, в grid выключаем звук ради плавности)
            let dest = null;
            if (options.template === 'news') {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                const audioCtx = new AudioContext();
                dest = audioCtx.createMediaStreamDestination();
                
                // Подключаем все видео к общему выходу
                videos.forEach(v => {
                    // Для новостного шаблона звук нужен
                    v.muted = false;
                    v.volume = 1;
                    const source = audioCtx.createMediaElementSource(v);
                    source.connect(dest);
                });
            }
            
            let ctaImage = null;
            if (options.ctaImageUrl) {
                try {
                    ctaImage = await loadImage(options.ctaImageUrl);
                } catch (e) { console.warn('Failed to load CTA image:', e); }
            }

            const canvas = document.getElementById('canvas');
            const ctx = canvas.getContext('2d');
            const mimeType = getMimeType();
            
            // Динамически подгоняем холст и body под шаблон (остаемся в 1080x1920, но гарантируем совпадение размеров)
            canvas.width = WIDTH;
            canvas.height = HEIGHT;
            canvas.style.width = WIDTH + 'px';
            canvas.style.height = HEIGHT + 'px';
            document.body.style.width = WIDTH + 'px';
            document.body.style.height = HEIGHT + 'px';

            // Snapshot режим (детерминированный покадровый рендер) для Grid
            if (renderMode === 'snapshot' && options.template === 'grid') {
                // Подготовка: останавливаем звук и воспроизведение
                videos.forEach(v => { v.pause(); v.currentTime = 0; v.muted = true; v.volume = 0; });

                const waitSeekAll = (t) => Promise.all(videos.map(v => new Promise(resolve => {
                    const dur = (v.duration && isFinite(v.duration)) ? v.duration : 0;
                    // ЗАЦИКЛИВАЕМ видео: если t > dur, используем остаток от деления
                    const targetTime = dur > 0 ? (t % dur) : t;

                    // Если видео очень короткое (< 0.1 сек), просто ставим на 0
                    if (dur < 0.1) {
                        v.currentTime = 0;
                        return resolve(true);
                    }

                    // Быстрый путь: уже на месте и кадр готов
                    const currentDiff = Math.abs(v.currentTime - targetTime);
                    if (currentDiff < 0.05 && v.readyState >= 2) {
                        return resolve(true);
                    }

                    // Устанавливаем время сразу
                    v.currentTime = targetTime;

                    // Максимально агрессивный polling: минимум ожидания
                    let attempts = 0;
                    const maxAttempts = 10; // 10 * 10ms = 100ms максимум (очень быстро!)
                    
                    const checkReady = () => {
                        attempts++;
                        const nowDiff = Math.abs(v.currentTime - targetTime);
                        
                        // Если время установлено и кадр готов (большой допуск для скорости)
                        if (nowDiff < 0.2 && v.readyState >= 2) {
                            resolve(true);
                            return;
                        }
                        
                        // Если превысили лимит попыток, продолжаем сразу (не ждём)
                        if (attempts >= maxAttempts) {
                            resolve(true);
                            return;
                        }
                        
                        // Очень частые проверки (10ms) для максимальной скорости
                        setTimeout(checkReady, 10);
                    };
                    
                    // Начинаем проверку сразу
                    checkReady();
                })));

                const drawGridFrame = (elapsed) => {
                    ctx.clearRect(0, 0, WIDTH, HEIGHT);
                    ctx.fillStyle = 'black';
                    ctx.fillRect(0, 0, WIDTH, HEIGHT);

                    const isContentPhase = elapsed < GRID_CONTENT_DURATION;

                    if (isContentPhase) {
                        const midX = WIDTH / 2;
                        const midY = HEIGHT / 2;
                        const pos = [
                            { x: 0, y: 0, w: midX, h: midY },
                            { x: midX, y: 0, w: midX, h: midY },
                            { x: 0, y: midY, w: midX, h: midY },
                            { x: midX, y: midY, w: midX, h: midY },
                        ];
                        
                        videos.forEach((v, i) => {
                            if (i < 4) drawVideoCover(ctx, v, pos[i].x, pos[i].y, pos[i].w, pos[i].h);
                        });
                        
                        ctx.lineWidth = 8;
                        ctx.strokeStyle = '#FF0000';
                        ctx.beginPath();
                        ctx.moveTo(0, midY); ctx.lineTo(WIDTH, midY);
                        ctx.moveTo(midX, 0); ctx.lineTo(midX, HEIGHT);
                        ctx.stroke();
                        
                        if (options.countries) {
                            const labels = options.countries;
                            ctx.font = '900 36px "Benzin-Bold", Arial'; 
                            ctx.textAlign = 'center';
                            ctx.textBaseline = 'middle';
                            ctx.shadowColor = 'rgba(0,0,0,0.8)';
                            ctx.shadowBlur = 15;
                            ctx.shadowOffsetX = 0;
                            ctx.shadowOffsetY = 4;
                            
                            const drawCountryText = (text, x, y) => {
                                if (!text) return;
                                ctx.save();
                                ctx.fillStyle = 'white';
                                ctx.fillText(formatCountry(text), x, y);
                                ctx.restore();
                            };

                            const textPadding = 120; 
                            if (labels[0]) drawCountryText(labels[0], midX/2, midY - textPadding);
                            if (labels[1]) drawCountryText(labels[1], midX + midX/2, midY - textPadding);
                            if (labels[2]) drawCountryText(labels[2], midX/2, midY + textPadding);
                            if (labels[3]) drawCountryText(labels[3], midX + midX/2, midY + textPadding);
                        }
                        
                        if (options.date) {
                            const stripH = 120; 
                            ctx.fillStyle = '#FF0000';
                            ctx.fillRect(0, midY - stripH/2, WIDTH, stripH);
                            
                            ctx.save();
                            ctx.font = '900 65px "Benzin-Bold", Arial';
                            ctx.fillStyle = 'white';
                            ctx.textAlign = 'center';
                            ctx.textBaseline = 'middle';
                            ctx.shadowColor = 'rgba(0,0,0,0.8)';
                            ctx.shadowBlur = 20;
                            ctx.shadowOffsetY = 5;
                            ctx.fillText(formatDate(options.date), midX, midY + 5);
                            ctx.restore();
                        }
                    } else {
                        const frameCount = Math.floor(elapsed * FPS);
                        drawImageCTA(ctx, frameCount, ctaImage);
                    }
                };

                window.renderFrameAt = async (t) => {
                    await waitSeekAll(t);
                    drawGridFrame(t);
                    return true;
                };

                window.renderReady = true;
                return;
            }
            
            // Повышаем битрейт: grid 22 Мбит/с, news 14 Мбит/с
            const bitRate = options.template === 'news' ? 14000000 : 22000000;
            
            const stream = canvas.captureStream(FPS);
            
            // ДОБАВЛЯЕМ АУДИО ТРЕК В ПОТОК ЗАПИСИ (только для news)
            if (dest) {
                const audioTrack = dest.stream.getAudioTracks()[0];
                if (audioTrack) {
                    stream.addTrack(audioTrack);
                }
            }
            
            const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitRate });
            const chunks = [];
            
            recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
            
            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: mimeType });
                fetch(uploadUrl, { method: 'POST', body: blob })
                    .then(res => {
                        if (res.ok) window.uploadComplete = true;
                        else throw new Error('Upload failed: ' + res.status);
                    })
                    .catch(err => { window.renderError = 'Upload error: ' + err.message; });
            };

            recorder.start();

            const totalDuration = (options.template === 'grid' ? GRID_CONTENT_DURATION : NEWS_CONTENT_DURATION) + CTA_DURATION;
            console.log('Total video duration:', totalDuration, 'seconds');
            console.log('NEWS_CONTENT_DURATION:', NEWS_CONTENT_DURATION, 'seconds');
            console.log('CTA_DURATION:', CTA_DURATION, 'seconds');
            const startTime = performance.now();
            let frameCount = 0;

            // Настройка воспроизведения: для grid запускаем все сразу, для news — переключаем по одному
            if (options.template === 'grid') {
                videos.forEach(v => {
                    v.loop = true;
                    v.muted = true;
                    v.volume = 0;
                    v.currentTime = 0;
                    v.playbackRate = 1;
                    v.play().catch(console.warn);
                });
            } else {
                videos.forEach(v => {
                    v.loop = false; // Отключаем loop, чтобы видео не повторялись
                    v.muted = false; // Для news звук нужен в итоговом ролике
                    v.volume = 1;    // Возвращаем громкость
                });
            }
            
            const newsVideosWithData = options.template === 'news' ? videos.map((v, i) => ({
                element: v,
                startTime: 0 
            })) : [];
            let currentNewsVideoIndex = -1;

            // Ограничиваем rAF по целевому FPS, чтобы избежать перепроизводства кадров
            const targetFrameMs = 1000 / FPS;
            let lastFrameTs = performance.now();

            function loop(now) {
                try {
                    // Пропускаем кадр, если ещё не прошло targetFrameMs
                    if (now - lastFrameTs < targetFrameMs - 1) {
                        requestAnimationFrame(loop);
                        return;
                    }
                    lastFrameTs = now;

                    const elapsed = (performance.now() - startTime) / 1000;
                    
                    if (elapsed >= totalDuration) {
                        recorder.stop();
                        videos.forEach(v => { v.pause(); v.src = ''; v.remove(); });
                        return;
                    }

                    // Очистка перед отрисовкой кадра
                    ctx.clearRect(0, 0, WIDTH, HEIGHT);

                    ctx.fillStyle = 'black';
                    ctx.fillRect(0, 0, WIDTH, HEIGHT);

                    const isContentPhase = elapsed < (options.template === 'grid' ? GRID_CONTENT_DURATION : NEWS_CONTENT_DURATION);
                    
                    if (isContentPhase) {
                        if (options.template === 'grid') {
                            const midX = WIDTH / 2;
                            const midY = HEIGHT / 2;
                            const pos = [
                                { x: 0, y: 0, w: midX, h: midY },
                                { x: midX, y: 0, w: midX, h: midY },
                                { x: 0, y: midY, w: midX, h: midY },
                                { x: midX, y: midY, w: midX, h: midY },
                            ];
                            
                            videos.forEach((v, i) => {
                                if (i < 4) drawVideoCover(ctx, v, pos[i].x, pos[i].y, pos[i].w, pos[i].h);
                            });
                            
                            // Уменьшаем толщину линий, чтобы снизить нагрузку на рендер
                            ctx.lineWidth = 8;
                            ctx.strokeStyle = '#FF0000';
                            ctx.beginPath();
                            ctx.moveTo(0, midY); ctx.lineTo(WIDTH, midY);
                            ctx.moveTo(midX, 0); ctx.lineTo(midX, HEIGHT);
                            ctx.stroke();
                            
                            if (options.countries) {
                                const labels = options.countries;
                                ctx.font = '900 36px "Benzin-Bold", Arial'; 
                                ctx.textAlign = 'center';
                                ctx.textBaseline = 'middle';
                                ctx.shadowColor = 'rgba(0,0,0,0.8)';
                                ctx.shadowBlur = 15;
                                ctx.shadowOffsetX = 0;
                                ctx.shadowOffsetY = 4;
                                
                                const drawCountryText = (text, x, y) => {
                                    if (!text) return;
                                    ctx.save();
                                    ctx.fillStyle = 'white';
                                    ctx.fillText(formatCountry(text), x, y);
                                    ctx.restore();
                                };

                                const textPadding = 120; 
                                if (labels[0]) drawCountryText(labels[0], midX/2, midY - textPadding);
                                if (labels[1]) drawCountryText(labels[1], midX + midX/2, midY - textPadding);
                                if (labels[2]) drawCountryText(labels[2], midX/2, midY + textPadding);
                                if (labels[3]) drawCountryText(labels[3], midX + midX/2, midY + textPadding);
                            }
                            
                            if (options.date) {
                                const stripH = 120; 
                                ctx.fillStyle = '#FF0000';
                                ctx.fillRect(0, midY - stripH/2, WIDTH, stripH);
                                
                                ctx.save();
                                ctx.font = '900 65px "Benzin-Bold", Arial';
                                ctx.fillStyle = 'white';
                                ctx.textAlign = 'center';
                                ctx.textBaseline = 'middle';
                                ctx.shadowColor = 'rgba(0,0,0,0.8)';
                                ctx.shadowBlur = 20;
                                ctx.shadowOffsetY = 5;
                                ctx.fillText(formatDate(options.date), midX, midY + 5);
                                ctx.restore();
                            }
                        } else {
                            // --- NEWS RENDER ---
                            // Видео переключаются каждые 6 секунд, всего 5 роликов
                            const videoIndex = Math.min(Math.floor(elapsed / NEWS_CLIP_DURATION), NEWS_CLIP_COUNT - 1);
                            
                            // Запускаем первое видео сразу при старте
                            if (currentNewsVideoIndex === -1 && videoIndex === 0 && newsVideosWithData.length > 0) {
                                const firstVid = newsVideosWithData[0];
                                if (firstVid && firstVid.element) {
                                    firstVid.element.currentTime = 0;
                                    firstVid.element.volume = 1;
                                    firstVid.element.play().catch(console.warn);
                                    currentNewsVideoIndex = 0;
                                }
                            }
                            
                            if (videoIndex !== currentNewsVideoIndex && videoIndex < newsVideosWithData.length && videoIndex < NEWS_CLIP_COUNT) {
                                // ОСТАНАВЛИВАЕМ ВСЕ ВИДЕО перед переключением, чтобы звук не накладывался
                                newsVideosWithData.forEach(v => {
                                    if (v && v.element) {
                                        v.element.pause();
                                        v.element.currentTime = 0;
                                        v.element.volume = 0; // Отключаем звук перед остановкой
                                    }
                                });
                                
                                const nextVid = newsVideosWithData[videoIndex];
                                if (nextVid && nextVid.element) {
                                    nextVid.element.currentTime = 0;
                                    nextVid.element.volume = 1; // Включаем звук для нового видео
                                    nextVid.element.play().catch(console.warn);
                                }
                                currentNewsVideoIndex = videoIndex;
                            }
                            
                            // Убеждаемся, что только текущее видео играет со звуком
                            newsVideosWithData.forEach((v, idx) => {
                                if (v && v.element) {
                                    if (idx === currentNewsVideoIndex) {
                                        v.element.volume = 1;
                                    } else {
                                        v.element.volume = 0;
                                        if (!v.element.paused) v.element.pause();
                                    }
                                }
                            });
                            
                            const activeData = newsVideosWithData[currentNewsVideoIndex];
                            if (activeData) drawVideoCover(ctx, activeData.element, 0, 0, WIDTH, HEIGHT);
                            
                            const grad = ctx.createLinearGradient(0, HEIGHT - 800, 0, HEIGHT);
                            grad.addColorStop(0, 'rgba(0,0,0,0)');
                            grad.addColorStop(1, 'rgba(0,0,0,0.7)');
                            ctx.fillStyle = grad;
                            ctx.fillRect(0, HEIGHT - 800, WIDTH, 800);

                            // LIVE Indicator
                            const liveX = WIDTH - 40 - 160; 
                            const liveY = 160;
                            const liveW = 160;
                            
                            ctx.fillStyle = '#cc0000';
                            ctx.fillRect(liveX, liveY, liveW, 50);
                            
                            if (Math.floor(elapsed * 2) % 2 === 0) {
                                ctx.fillStyle = 'white';
                                ctx.beginPath();
                                ctx.arc(liveX + 30, liveY + 25, 8, 0, Math.PI * 2);
                                ctx.fill();
                            }
                            ctx.font = 'bold 30px "Benzin-Bold", Arial';
                            ctx.fillStyle = 'white';
                            ctx.textAlign = 'left';
                            ctx.textBaseline = 'middle';
                            ctx.fillText("LIVE", liveX + 60, liveY + 26);
                            
                            if (elapsed < NEWS_HEADER_DURATION) {
                                // 0-2s: HEADER (Единая белая плашка)
                                const headerY = HEIGHT / 2;
                                const centerX = WIDTH / 2;
                                
                                let cText = "";
                                let dText = "";
                                let cW = 0;
                                let dW = 0;
                                let cFontSize = 90;
                                let dFontSize = 60;
                                
                                // 1. Вычисляем размеры СТРАНЫ
                                if (options.country) {
                                    ctx.font = \`900 \${cFontSize}px "Benzin-Bold", Arial\`;
                                    cText = formatCountryNews(options.country);
                                    
                                    // Авто-уменьшение шрифта если длинное название
                                    const maxScreenW = WIDTH - 100;
                                    let tempW = ctx.measureText(cText).width;
                                    while ((tempW + 80) > maxScreenW && cFontSize > 40) {
                                        cFontSize -= 5;
                                        ctx.font = \`900 \${cFontSize}px "Benzin-Bold", Arial\`;
                                        tempW = ctx.measureText(cText).width;
                                    }
                                    cW = tempW;
                                }
                                
                                // 2. Вычисляем размеры ДАТЫ
                                if (options.date) {
                                    ctx.font = \`900 \${dFontSize}px "Benzin-Bold", Arial\`;
                                    dText = options.date;
                                    dW = ctx.measureText(dText).width;
                                }
                                
                                // 3. Определяем общую ширину плашки (по самому широкому элементу)
                                const boxW = Math.max(cW, dW) + 120;
                                const boxH = 170; // Больше высоты, чтобы дата была выше страны
                                const boxY = headerY - boxH / 2; // Центр по экрану
                                
                                ctx.shadowBlur = 0;
                                
                                // РИСУЕМ ОБЩУЮ БЕЛУЮ ПЛАШКУ
                                ctx.fillStyle = 'white';
                                ctx.fillRect(centerX - boxW/2, boxY, boxW, boxH);
                                
                                // РИСУЕМ ДАТУ (Сверху, черная)
                                if (dText) {
                                    ctx.font = \`900 \${dFontSize}px "Benzin-Bold", Arial\`;
                                    ctx.fillStyle = 'black';
                                    ctx.textAlign = 'center';
                                    ctx.textBaseline = 'top';
                                    // Отступ сверху плашки
                                    ctx.fillText(dText, centerX, boxY + 12);
                                }
                                
                                // РИСУЕМ СТРАНУ (Снизу, красная)
                                if (cText) {
                                    ctx.font = \`900 \${cFontSize}px "Benzin-Bold", Arial\`;
                                    ctx.fillStyle = '#FF0000';
                                    ctx.textAlign = 'center';
                                    ctx.textBaseline = 'bottom';
                                    // Отступ снизу плашки
                                    ctx.fillText(cText, centerX, boxY + boxH - 12);
                                }
                                
                            } else {
                                // 2s+: TICKERS (текст и начитка начинаются одновременно со 2 секунды)
                                if (options.tickers && options.tickers.length > 0) {
                                const tickerTime = elapsed - NEWS_INITIAL_SILENCE; // Отсчёт от 2 секунды
                                const tickerDuration = NEWS_TICKER_DURATION;
                                const tickerIndex = Math.floor(tickerTime / tickerDuration);
                                    
                                    if (tickerIndex >= 0 && tickerIndex < NEWS_TICKER_COUNT) {
                                        // Делаем первую букву заглавной и убираем кавычки/скобки
                                        let rawTicker = options.tickers[tickerIndex];
                                        // Убираем кавычки и квадратные скобки
                                        rawTicker = rawTicker ? rawTicker.replace(/["'«»„"]/g, '').replace(/[\[\]]/g, '').trim() : '';
                                        const currentTicker = rawTicker ? rawTicker.charAt(0).toUpperCase() + rawTicker.slice(1) : '';
                                        
                                        if (currentTicker) {
                                            const localTime = tickerTime % tickerDuration;
                                            let alpha = 1;
                                            if (localTime < 0.3) alpha = localTime / 0.3;
                                            else if (localTime > tickerDuration - 0.3) alpha = (tickerDuration - localTime) / 0.3;
                                            
                                            if (alpha > 0.01) {
                                                ctx.save();
                                                ctx.globalAlpha = alpha;
                                                const safeBottom = HEIGHT - 400;
                                                const quoteSize = 50;
                                                const safeMarginX = 160; // придерживаемся safe zone TikTok
                                                const startX = safeMarginX; // смещаем левее, чтобы не уползало вправо
                                                
                                                let fontSize = 32; 
                                                ctx.font = \`bold \${fontSize}px Arial, sans-serif\`;
                                                const maxTextW = WIDTH - safeMarginX * 2 - quoteSize - 40; 
                                                let lines = getLines(ctx, currentTicker, maxTextW);
                                                
                                                while (lines.length > 10 && fontSize > 20) {
                                                    fontSize -= 2;
                                                    ctx.font = \`bold \${fontSize}px Arial, sans-serif\`;
                                                    lines = getLines(ctx, currentTicker, maxTextW);
                                                }
                                                
                                                const gap = 2; // Экстремально маленький отступ
                                                const boxHeight = fontSize + 4; // Очень компактная плашка
                                                
                                                const totalH = (lines.length * boxHeight) + ((lines.length - 1) * gap);
                                                const startY = safeBottom - totalH;
                                                
                                                drawQuoteIcon(ctx, startX, startY, quoteSize);
                                                
                                                const textX = startX + quoteSize + 12;
                                                
                                                lines.forEach((line, i) => {
                                                    const y = startY + (i * (boxHeight + gap));
                                                    const textW = ctx.measureText(line).width;
                                                    
                                                    ctx.fillStyle = 'white';
                                                    ctx.fillRect(textX, y, textW + 20, boxHeight);
                                                    
                                                    ctx.fillStyle = 'black';
                                                    ctx.textAlign = 'left';
                                                    ctx.textBaseline = 'top';
                                                    ctx.fillText(line, textX + 10, y + 2); // y + 2 чтобы текст был выше внутри узкой плашки
                                                });
                                                ctx.restore();
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        if (options.template === 'news') {
                             // ПРИНУДИТЕЛЬНО ОСТАНАВЛИВАЕМ ВСЕ ВИДЕО И ОТКЛЮЧАЕМ ЗВУК
                             newsVideosWithData.forEach(v => {
                                 if (v && v.element) {
                                     v.element.pause();
                                     v.element.currentTime = 0;
                                     v.element.volume = 0;
                                 }
                             });
                             videos.forEach(v => {
                                 v.pause();
                                 v.currentTime = 0;
                                 v.volume = 0;
                             });
                        }
                        drawImageCTA(ctx, frameCount, ctaImage);
                    }
                    frameCount++;
                    requestAnimationFrame(loop);
                } catch (e) {
                    recorder.stop();
                    window.renderError = 'Loop error: ' + e.message;
                }
            }
            requestAnimationFrame(loop);
        } catch (e) {
            window.renderError = 'Setup error: ' + e.message;
        }
    }
    startRendering();
  </script>
</body>
</html>
  `;
}

export async function renderVideo(options: RenderOptions, serverPort: number = 3000): Promise<string> {
  let browser;
  const browserErrors: string[] = [];
  const consoleMessages: string[] = [];
  
  try {
    console.log(`Starting render for template: ${options.template}, videos: ${options.videos.length}`);

    // Для Grid по умолчанию используем детерминированный покадровый рендер
    if (!options.renderMode) {
      options.renderMode = options.template === 'grid' ? 'snapshot' : 'realtime';
    }
    
    if (!options.ctaImageUrl) {
      const imagesDir = path.join(__dirname, 'assets', 'images');
      try {
        const imageFiles = await fs.readdir(imagesDir);
        const imageFile = imageFiles.find(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
        if (imageFile) {
          options.ctaImageUrl = `http://localhost:${serverPort}/assets/images/${imageFile}`;
        }
      } catch (e) {}
    }
    
    const browserVideoUrls = await prepareVideosForBrowser(options.videos, serverPort);

    // Ищем исполняемый файл Chrome/Chromium
    const candidatePaths = [
      process.env.CHROME_PATH,
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ].filter(Boolean) as string[];

    let executablePath: string | undefined = undefined;
    for (const p of candidatePaths) {
      try { await fs.access(p); executablePath = p; break; } catch {}
    }

    if (!executablePath) {
      console.warn('Chromium/Chrome executable not found, Puppeteer will try default');
    } else {
      console.log(`Using Chromium executable: ${executablePath}`);
    }

    browser = await puppeteer.launch({
      headless: "new", // Новый режим быстрее и стабильнее
      executablePath,
      pipe: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-extensions', '--no-first-run', '--no-zygote',
        '--disable-web-security', '--autoplay-policy=no-user-gesture-required',
        '--disable-gpu', // Отключаем GPU для ускорения в headless
        '--disable-software-rasterizer',
        '--disable-frame-rate-limit', '--disable-gpu-vsync',
        '--disable-background-networking', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });

    page.on('console', (msg) => {
      const text = msg.text();
      if (!text.includes('deprecated') && !text.includes('violation')) consoleMessages.push(`[Browser ${msg.type()}]: ${text}`);
      if (msg.type() === 'error') browserErrors.push(text);
    });
    page.on('pageerror', (error) => browserErrors.push(`Page Error: ${error.message}`));
    page.on('requestfailed', (request) => browserErrors.push(`Request failed: ${request.url()}`));

    const videoId = `${options.template}_${Date.now()}`;
    const uploadUrl = `http://localhost:${serverPort}/upload-result/${videoId}`;
    const htmlContent = await createRendererPage(options, browserVideoUrls, uploadUrl, serverPort);
    
    await page.setContent(htmlContent);

    // --- Snapshot режим для Grid: покадровый рендер с ffmpeg (image2pipe) ---
    if (options.renderMode === 'snapshot' && options.template === 'grid') {
      const fps = 30;
      const totalDuration = 20 + 5; // GRID_CONTENT_DURATION + CTA_DURATION
      const totalFrames = Math.round(totalDuration * fps);
      const outputPath = path.join(__dirname, 'temp', `${videoId}.mp4`);

      // Ждём готовности рендер-функции в браузере
      await page.waitForFunction(() => {
        // @ts-ignore
        return window.renderReady === true || window.renderError !== undefined;
      }, { timeout: 600000 });

      const renderError = await page.evaluate(() => {
        // @ts-ignore
        return window.renderError;
      });
      if (renderError) throw new Error(`Browser error: ${renderError}`);

      const ffmpegArgs = [
        '-y',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-r', `${fps}`,
        '-i', 'pipe:0',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'fast', // Быстрее для ускорения рендеринга
        '-crf', '20', // Немного выше для ускорения (приемлемое качество)
        '-r', `${fps}`,
        '-g', `${fps * 2}`,
        '-bf', '0',
        '-vsync', '1',
        // Гарантируем 9:16 без растяжения
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(1080-iw)/2:(1920-ih)/2',
        '-movflags', '+faststart',
        outputPath
      ];

      const ff = spawn(ffmpegPath || 'ffmpeg', ffmpegArgs);

      // Логируем ошибки FFmpeg для диагностики
      let ffmpegStderr = '';
      ff.stderr.on('data', (data) => {
        const text = data.toString();
        ffmpegStderr += text;
        // Логируем только важные сообщения (не все frame=...)
        if (text.includes('error') || text.includes('Error') || text.includes('failed')) {
          console.error(`[FFmpeg] ${text.trim()}`);
        }
      });

      const ffmpegDone = new Promise<void>((resolve, reject) => {
        ff.on('error', (err) => {
          console.error('[FFmpeg] Process error:', err);
          reject(err);
        });
        ff.on('close', (code) => {
          if (code === 0) {
            console.log('[FFmpeg] Encoding completed successfully');
            resolve();
          } else {
            console.error(`[FFmpeg] Exited with code ${code}`);
            console.error(`[FFmpeg] stderr: ${ffmpegStderr.slice(-500)}`); // Последние 500 символов
            reject(new Error(`ffmpeg exited with code ${code}`));
          }
        });
      });

      console.log(`Rendering ${totalFrames} frames (${totalDuration}s @ ${fps} FPS)...`);
      const logInterval = Math.max(1, Math.floor(totalFrames / 20)); // Логируем каждые 5%
      const renderStartTime = Date.now();
      let lastLogTime = renderStartTime;
      
      for (let i = 0; i < totalFrames; i++) {
        const frameStartTime = Date.now();
        const t = i / fps;
        
        // Логируем прогресс с информацией о скорости
        if (i % logInterval === 0 || i === totalFrames - 1) {
          const progress = ((i + 1) / totalFrames * 100).toFixed(1);
          const elapsed = (Date.now() - renderStartTime) / 1000;
          const avgFps = (i + 1) / elapsed;
          const recentFps = logInterval / ((Date.now() - lastLogTime) / 1000);
          console.log(`Frame ${i + 1}/${totalFrames} (${progress}%) - time: ${t.toFixed(2)}s | avg: ${avgFps.toFixed(1)} fps | recent: ${recentFps.toFixed(1)} fps`);
          lastLogTime = Date.now();
        }
        
        try {
          const evalStart = Date.now();
          await page.evaluate((time) => {
            // @ts-ignore
            return window.renderFrameAt(time);
          }, t);
          const evalTime = Date.now() - evalStart;
          
          const screenshotStart = Date.now();
          // Агрессивно снижаем quality для максимального ускорения (60 - приемлемое качество, но намного быстрее)
          const buffer = await page.screenshot({ type: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
          const screenshotTime = Date.now() - screenshotStart;
          
          // Проверяем, что FFmpeg не завершился с ошибкой
          if (ff.stdin.destroyed || ff.killed) {
            throw new Error('FFmpeg process terminated unexpectedly');
          }
          
          const writeStart = Date.now();
          if (!ff.stdin.write(buffer)) {
            // Буфер переполнен, ждём drain
            await new Promise(resolve => ff.stdin.once('drain', resolve));
          }
          const writeTime = Date.now() - writeStart;
          
          // Логируем медленные кадры для диагностики
          const frameTime = Date.now() - frameStartTime;
          if (frameTime > 500) {
            console.warn(`Slow frame ${i + 1}: eval=${evalTime}ms, screenshot=${screenshotTime}ms, write=${writeTime}ms, total=${frameTime}ms`);
          }
        } catch (error: any) {
          console.error(`Error at frame ${i + 1} (time ${t.toFixed(2)}s):`, error.message);
          throw new Error(`Rendering failed at frame ${i + 1}: ${error.message}`);
        }
      }

      ff.stdin.end();
      await ffmpegDone;
      return outputPath;
    }

    // --- Реал-тайм режим (MediaRecorder) ---
    console.log('Waiting for render/upload...');
    try {
      await page.waitForFunction(() => {
        // @ts-ignore
        return window.uploadComplete === true || window.renderError !== undefined;
      }, { timeout: 600000 }); 
    } catch (error: any) {
      throw new Error(`Timeout. ${browserErrors.length > 0 ? 'Browser errors: ' + browserErrors.join('; ') : ''}`);
    }

    const renderError = await page.evaluate(() => {
        // @ts-ignore
        return window.renderError; 
    });
    if (renderError) throw new Error(`Browser error: ${renderError}`);

    console.log('Render success');
    const outputPath = path.join(__dirname, 'temp', `${videoId}.webm`);
    
    try { await fs.access(outputPath); } catch {
      throw new Error('Output file missing');
    }

    return outputPath;
    
  } catch (error) {
    console.error('Render error:', error);
    let errorMsg = error instanceof Error ? error.message : String(error);
    if (browserErrors.length > 0) errorMsg += ` | Browser errors: ${browserErrors.join('; ')}`;
    throw new Error(errorMsg);
  } finally {
    try {
      const browserVideoDir = path.join(__dirname, 'temp', 'browser_videos');
      await fs.rm(browserVideoDir, { recursive: true, force: true });
    } catch (e) {}
    if (browser) await browser.close().catch(() => {});
  }
}