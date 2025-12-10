import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import puppeteer from 'puppeteer';

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
    const WIDTH = 1080;
    const HEIGHT = 1920;
    const FPS = 30;
    
    // --- TIMING CONFIG ---
    const GRID_CONTENT_DURATION = 20; 
    const NEWS_HEADER_DURATION = 4; // секунды показа шапки (дата+страна)
    const NEWS_TICKER_COUNT = 3; // количество текстовых блоков от Perplexity
    const NEWS_CLIP_DURATION = 6; // длительность каждого ролика
    const NEWS_CLIP_COUNT = 5; // количество роликов
    const CTA_DURATION = 5; // призыв к действию
    // Вычисляем длительность каждого текстового блока:
    // Всего видео: 5 роликов * 6 сек = 30 сек + CTA 5 сек = 35 сек
    // Контент до CTA: 35 - 5 = 30 сек
    // После шапки (4 сек): 30 - 4 = 26 сек
    // На 3 блока: 26 / 3 = 8.67 сек каждый
    const NEWS_TICKER_DURATION = (NEWS_CLIP_COUNT * NEWS_CLIP_DURATION + CTA_DURATION - NEWS_HEADER_DURATION - CTA_DURATION) / NEWS_TICKER_COUNT;
    const NEWS_CONTENT_DURATION = NEWS_HEADER_DURATION + NEWS_TICKER_DURATION * NEWS_TICKER_COUNT; // 4 + 26 = 30 сек 
    
    const options = ${serializedOptions};
    const videoUrls = ${serializedVideoUrls};
    const uploadUrl = "${uploadUrl}";
    
    window.videosLoaded = false;
    window.uploadComplete = false;
    window.renderError = undefined;

    // --- UTILS ---

    const toTitleCase = (str) => {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
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
        video.muted = false; // ВКЛЮЧАЕМ ЗВУК
        video.volume = 1.0;
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
      if (video.videoWidth === 0) return;
      const videoRatio = video.videoWidth / video.videoHeight;
      const targetRatio = w / h;
      let sx, sy, sw, sh;

      if (videoRatio > targetRatio) {
        sh = video.videoHeight;
        sw = sh * targetRatio;
        sy = 0;
        sx = (video.videoWidth - sw) / 2;
      } else {
        sw = video.videoWidth;
        sh = sw / targetRatio;
        sx = 0;
        sy = (video.videoHeight - sh) / 2;
      }
      ctx.drawImage(video, sx, sy, sw, sh, x, y, w, h);
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
        
        const safeBottom = HEIGHT - 400; 
        const centerX = WIDTH / 2;
        
        let imageY = 300; 
        const imgW = 700; 
        let imgH = 0;
        let imgX = (WIDTH - imgW) / 2;

        if (ctaImage && ctaImage.complete) {
            const imgRatio = ctaImage.width / ctaImage.height;
            imgH = imgW / imgRatio;
            
            ctx.save();
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 30;
            ctx.shadowOffsetY = 20;
            
            const radius = 30;
            ctx.beginPath();
            ctx.roundRect(imgX, imageY, imgW, imgH, radius);
            ctx.closePath();
            
            ctx.fill();
            ctx.clip();
            
            ctx.drawImage(ctaImage, imgX, imageY, imgW, imgH);
            ctx.restore();
        } else {
            imgH = 600; 
            imageY = HEIGHT / 2 - 400;
        }

        // CTA текст в том же стиле, что и текстовые блоки
        const ctaText = "О причинах учащения природных катастроф и прогнозах на ближайшие годы - в климатическом докладе учёных АЛЛАТРА";
        
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
            
            // НАСТРОЙКА ЗВУКА
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            const audioCtx = new AudioContext();
            const dest = audioCtx.createMediaStreamDestination();
            
            // Подключаем все видео к общему выходу
            videos.forEach(v => {
                const source = audioCtx.createMediaElementSource(v);
                source.connect(dest);
            });
            
            let ctaImage = null;
            if (options.ctaImageUrl) {
                try {
                    ctaImage = await loadImage(options.ctaImageUrl);
                } catch (e) { console.warn('Failed to load CTA image:', e); }
            }

            const canvas = document.getElementById('canvas');
            const ctx = canvas.getContext('2d');
            const mimeType = getMimeType();
            
            const bitRate = options.template === 'news' ? 8000000 : 5000000;
            
            const stream = canvas.captureStream(FPS);
            
            // ДОБАВЛЯЕМ АУДИО ТРЕК В ПОТОК ЗАПИСИ
            const audioTrack = dest.stream.getAudioTracks()[0];
            if (audioTrack) {
                stream.addTrack(audioTrack);
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

            // НЕ запускаем все видео сразу - запускаем только при переключении
            videos.forEach(v => {
                v.loop = false; // Отключаем loop, чтобы видео не повторялись
                v.volume = 0; // Отключаем звук по умолчанию
            });
            
            const newsVideosWithData = options.template === 'news' ? videos.map((v, i) => ({
                element: v,
                startTime: 0 
            })) : [];
            let currentNewsVideoIndex = -1;

            function loop() {
                try {
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
                            
                            ctx.lineWidth = 15;
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
                                    ctx.fillText(toTitleCase(text), x, y);
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
                                // 0-3s: HEADER (Единая белая плашка)
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
                                    cText = options.country.toUpperCase();
                                    
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
                                // 3s+: TICKERS
                                if (options.tickers && options.tickers.length > 0) {
                                const tickerTime = elapsed - NEWS_HEADER_DURATION;
                                const tickerDuration = NEWS_TICKER_DURATION;
                                const tickerIndex = Math.floor(tickerTime / tickerDuration);
                                    
                                    if (tickerIndex >= 0 && tickerIndex < NEWS_TICKER_COUNT) {
                                        // Делаем первую букву заглавной
                                        let rawTicker = options.tickers[tickerIndex];
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
            loop();
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
      headless: true,
      executablePath,
      pipe: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-extensions', '--no-first-run', '--no-zygote',
        '--disable-web-security', '--autoplay-policy=no-user-gesture-required',
        '--enable-gpu-rasterization', '--enable-zero-copy'
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920 });

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