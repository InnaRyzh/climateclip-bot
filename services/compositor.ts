
import { GridTemplateData, NewsTemplateData, VideoFile } from "../types";

// Константы конфигурации
const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;

// Длительности
const GRID_CONTENT_DURATION = 20; 
const NEWS_CLIP_DURATION = 5; 
const NEWS_CONTENT_DURATION = NEWS_CLIP_DURATION * 5; 
const CTA_DURATION = 5; // 5 секунд заставка

// Подбор MIME типа для MP4
const getMimeType = () => {
  const types = [
    'video/mp4; codecs="avc1.42E01E, mp4a.40.2"', // H.264 (Самый совместимый)
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

// Загрузка видео элемента
const loadVideo = (src: string): Promise<HTMLVideoElement> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.src = src;
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');

    const timeout = setTimeout(() => {
      reject(new Error('Таймаут загрузки видео'));
    }, 10000); // 10 секунд таймаут

    const checkReady = () => {
      if (video.readyState >= 2) {
        clearTimeout(timeout);
        resolve(video);
      } else {
        const onLoaded = () => {
          clearTimeout(timeout);
          resolve(video);
        };
        const onError = () => {
          clearTimeout(timeout);
          reject(new Error('Ошибка загрузки видео'));
        };
        video.addEventListener('loadeddata', onLoaded, { once: true });
        video.addEventListener('error', onError, { once: true });
        video.load();
      }
    };
    checkReady();
  });
};

// Загрузка изображения
const loadImage = (src: string): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
};

// Хелпер для отрисовки видео с object-fit: cover
const drawVideoCover = (ctx: CanvasRenderingContext2D, video: HTMLVideoElement, x: number, y: number, w: number, h: number) => {
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

// Простая отрисовка текста с обводкой (Legacy style)
const drawTextWithShadow = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string = 'white', fontSize: number = 40, align: CanvasTextAlign = 'center', fontFace: string = 'Arial', fontWeight: string = 'bold', shadowBlur: number = 0) => {
  ctx.save();
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.font = `${fontWeight} ${fontSize}px ${fontFace}, sans-serif`;
  
  if (shadowBlur > 0) {
      ctx.shadowColor = 'black';
      ctx.shadowBlur = shadowBlur;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;
  } else {
      ctx.lineWidth = fontSize * 0.1; 
      ctx.strokeStyle = 'black';
      ctx.strokeText(text, x, y);
  }
  
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
};

// Функция для разбиения текста на строки (word wrap)
const getLines = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number) => {
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

// Отрисовка логотипа "КЛИМАТИЧЕСКИЙ ЦЕРБЕР"
const drawLogo = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number = 200) => {
    ctx.save();
    
    // Оранжево-красный фон с эффектом огня/трещин
    const gradient = ctx.createRadialGradient(x + size/2, y + size/2, 0, x + size/2, y + size/2, size/2);
    gradient.addColorStop(0, '#ff6b35'); // Яркий оранжевый
    gradient.addColorStop(0.5, '#ff4500'); // Оранжево-красный
    gradient.addColorStop(1, '#cc3300'); // Темно-красный
    
    // Круглый фон
    ctx.beginPath();
    ctx.arc(x + size/2, y + size/2, size/2, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
    
    // Обводка
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 3;
    ctx.stroke();
    
    // Текст логотипа
    ctx.font = 'bold 24px Arial';
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Разбиваем текст на две строки
    const text1 = 'КЛИМАТИЧЕСКИЙ';
    const text2 = 'ЦЕРБЕР';
    
    ctx.fillText(text1, x + size/2, y + size/2 - 12);
    ctx.fillText(text2, x + size/2, y + size/2 + 12);
    
    ctx.restore();
};

// Отрисовка зеленой иконки кавычек
const drawQuoteIcon = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number = 60) => {
    ctx.save();
    ctx.fillStyle = '#22c55e'; // Зеленый цвет
    ctx.font = `bold ${size}px Arial`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('"', x, y);
    ctx.restore();
};

// Отрисовка заставки-картинки с текстом и пальцем
const drawImageCTA = (ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, frameCount: number) => {
    // 1. Рисуем фон (картинку)
    // Черный фон по умолчанию
    ctx.fillStyle = '#0f0f12'; // Очень темный фон под докладом
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    if (img) {
        // Рисуем картинку по центру, немного уменьшенную (как обложка книги)
        const targetW = 800;
        const imgRatio = img.width / img.height;
        const targetH = targetW / imgRatio;
        
        // Центрируем
        const x = (WIDTH - targetW) / 2;
        const y = (HEIGHT - targetH) / 2;
        
        ctx.drawImage(img, x, y, targetW, targetH);
        
        // Легкая тень для объема
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, targetW, targetH);
    } 

    // 3. Текст "О причинах..." (Скриншот 3)
    // Рисуем текст на белых плашках с зеленой иконкой кавычек
    const sentences = [
        "О причинах учащения",
        "природных катаклизмов и",
        "прогнозах на ближайшие",
        "годы - в климатическом",
        "докладе учёных АЛЛАТРА"
    ];

    ctx.font = '900 48px Arial';
    ctx.textBaseline = 'middle';
    const startY = HEIGHT - 650;
    const startX = 50;
    const lineHeight = 65;
    
    // Зеленая иконка кавычек в начале текста
    drawQuoteIcon(ctx, startX + 10, startY - 15, 60);

    sentences.forEach((line, i) => {
        const textW = ctx.measureText(line).width;
        const pad = 20;
        const y = startY + (i * lineHeight);
        
        // Белая плашка с отступом для иконки кавычек
        ctx.fillStyle = 'white';
        ctx.fillRect(startX + 80, y - 25, textW + (pad*2), 55);

        // Текст
        ctx.fillStyle = 'black';
        ctx.textAlign = 'left';
        ctx.fillText(line, startX + 80 + pad, y + 2);
    });
    
    // Логотип в правом нижнем углу
    drawLogo(ctx, WIDTH - 220, HEIGHT - 220, 180);

    // 4. Анимация стрелки (Вместо руки)
    const t = (frameCount % 60) / 60; // 0 to 1 every second
    const offset = Math.sin(t * Math.PI * 2) * 15; // Bobbing motion

    const arrowX = WIDTH - 250;
    const arrowY = HEIGHT - 350 + offset;

    ctx.save();
    ctx.translate(arrowX, arrowY);
    ctx.rotate(Math.PI / 4); // Наклон стрелки в угол

    // Рисуем жирную стрелку
    ctx.fillStyle = 'white';
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 4;
    
    ctx.beginPath();
    ctx.moveTo(-20, -60);
    ctx.lineTo(20, -60);
    ctx.lineTo(20, 20);
    ctx.lineTo(50, 20);
    ctx.lineTo(0, 80); // Tip
    ctx.lineTo(-50, 20);
    ctx.lineTo(-20, 20);
    ctx.closePath();
    
    ctx.fill();
    ctx.stroke();

    ctx.restore();
};

// --- RENDER GRID 4x ---
export const renderGridVideo = async (data: GridTemplateData, onProgress: (p: number) => void): Promise<Blob> => {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas context');

  // Загружаем видео с обработкой ошибок
  const loadedVideos = await Promise.all(
    data.videos.map(async (v) => {
      if (!v || !v.previewUrl) {
        return null;
      }
      try {
        return await loadVideo(v.previewUrl);
      } catch (e) {
        console.error('Ошибка загрузки видео:', e);
        throw new Error(`Не удалось загрузить видео: ${e instanceof Error ? e.message : String(e)}`);
      }
    })
  );
  
  // Проверяем, что все видео загружены
  const validVideos = loadedVideos.filter(v => v !== null);
  if (validVideos.length !== 4) {
    throw new Error(`Загружено только ${validVideos.length} из 4 видео`);
  }
  
  let ctaImageEl: HTMLImageElement | null = null;
  if (data.ctaImage) {
      try {
        ctaImageEl = await loadImage(URL.createObjectURL(data.ctaImage));
      } catch (e) {
        console.warn('Ошибка загрузки CTA изображения:', e);
      }
  }

  const mimeType = getMimeType();
  const stream = canvas.captureStream(FPS);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 }); // 5 Mbps
  const chunks: Blob[] = [];
  
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  return new Promise((resolve, reject) => {
    recorder.onerror = (e) => {
      console.error('MediaRecorder error:', e);
      reject(new Error('Ошибка записи видео'));
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      if (chunks.length === 0) {
        reject(new Error('Видео не было записано. Проверьте, что все видео загружены.'));
        return;
      }
      resolve(blob);
    };

    try {
      recorder.start();
    } catch (e) {
      reject(new Error('Не удалось запустить запись видео: ' + e));
      return;
    }

    const totalDuration = GRID_CONTENT_DURATION + CTA_DURATION;
    const startTime = performance.now();
    let frameCount = 0;

    // Используем уже проверенные validVideos из загрузки
    validVideos.forEach(v => {
        if(v) { 
          v.loop = true; 
          v.play().catch(e => {
            console.warn('Video play error:', e);
          });
        }
    });

    const loop = () => {
      try {
        const elapsed = (performance.now() - startTime) / 1000;
        onProgress(Math.min(elapsed / totalDuration, 0.99));

        if (elapsed >= totalDuration) {
          recorder.stop();
          validVideos.forEach(v => { 
            if(v) { 
              v.pause(); 
              v.src = ''; 
              v.remove(); 
            } 
          });
          return;
        }

        // --- DRAW FRAME ---
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, WIDTH, HEIGHT);

        if (elapsed < GRID_CONTENT_DURATION) {
        // Grid Layout
        const midY = HEIGHT / 2;
        const midX = WIDTH / 2;
        const positions = [
            { x: 0, y: 0, w: midX, h: midY },
            { x: midX, y: 0, w: midX, h: midY },
            { x: 0, y: midY, w: midX, h: midY },
            { x: midX, y: midY, w: midX, h: midY },
        ];

        validVideos.forEach((video, i) => {
            if (video && i < positions.length) {
              drawVideoCover(ctx, video, positions[i].x, positions[i].y, positions[i].w, positions[i].h);
            }
        });

        // Modern Separators
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'white';
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(WIDTH, midY);
        ctx.moveTo(midX, 0);
        ctx.lineTo(midX, HEIGHT);
        ctx.stroke();

        // Modern Country Badges
        const labels = data.countryLabels;
        const drawBadge = (text: string, x: number, y: number, align: 'left' | 'right') => {
            if (!text) return;
            ctx.font = 'bold 36px Arial';
            const w = ctx.measureText(text.toUpperCase()).width + 40;
            const h = 60;
            
            let bx = align === 'left' ? x : x - w;
            
            // Shadow box
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillRect(bx, y, w, h);
            
            // Accent line
            ctx.fillStyle = '#ef4444'; // Red accent
            ctx.fillRect(align === 'left' ? bx : bx + w - 5, y, 5, h);

            // Text
            ctx.fillStyle = 'white';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(text.toUpperCase(), align === 'left' ? bx + 20 : bx + 15, y + h/2);
        };

        const offset = 40;
        if (labels[0]) drawBadge(labels[0], offset, offset + 40, 'left');
        if (labels[1]) drawBadge(labels[1], WIDTH - offset, offset + 40, 'right');
        if (labels[2]) drawBadge(labels[2], offset, HEIGHT - midY + offset + 40, 'left');
        if (labels[3]) drawBadge(labels[3], WIDTH - offset, HEIGHT - midY + offset + 40, 'right');

        // Center Date Strip (Modern)
        if (data.centerDate) {
            const stripH = 90;
            ctx.fillStyle = '#ef4444'; // Brand Red
            ctx.fillRect(0, midY - stripH/2, WIDTH, stripH);
            
            ctx.font = '900 44px Arial';
            ctx.fillStyle = 'white';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(data.centerDate.toUpperCase(), midX, midY);
        }
        
        // Логотип в правом нижнем углу
        drawLogo(ctx, WIDTH - 200, HEIGHT - 200, 160);

        } else {
          drawImageCTA(ctx, ctaImageEl, frameCount);
        }

        frameCount++;
        requestAnimationFrame(loop);
      } catch (e) {
        console.error('Render loop error:', e);
        recorder.stop();
        validVideos.forEach(v => { 
          if(v) { 
            v.pause(); 
            v.src = ''; 
            v.remove(); 
          } 
        });
        reject(new Error('Ошибка при рендеринге кадра: ' + e));
      }
    };

    loop();
  });
};

// --- RENDER NEWS SEQUENCE (MODERN CNN STYLE) ---
export const renderNewsVideo = async (data: NewsTemplateData, onProgress: (p: number) => void): Promise<Blob> => {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas context');
  
    const loadedVideos = await Promise.all(data.videos.map(v => v.previewUrl ? loadVideo(v.previewUrl) : null));
    const validVideos = loadedVideos.filter(v => v !== null) as HTMLVideoElement[];
    
    const videosWithData = validVideos.map((v, i) => ({
        element: v,
        startTime: data.videos[i].startTime || 0
    }));

    let ctaImageEl: HTMLImageElement | null = null;
    if (data.ctaImage) {
        ctaImageEl = await loadImage(URL.createObjectURL(data.ctaImage));
    }
  
    const mimeType = getMimeType();
    const stream = canvas.captureStream(FPS);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8000000 }); // 8 Mbps high quality
    const chunks: Blob[] = [];
    
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  
    return new Promise((resolve, reject) => {
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        resolve(blob);
      };
  
      recorder.start();
  
      const totalDuration = NEWS_CONTENT_DURATION + CTA_DURATION;
      const startTime = performance.now();
      let currentVideoIndex = -1;
      let frameCount = 0;

      const loop = () => {
        const elapsed = (performance.now() - startTime) / 1000;
        
        if (elapsed >= totalDuration) {
          recorder.stop();
          validVideos.forEach(v => { v.pause(); v.src = ''; v.remove(); });
          return;
        }

        onProgress(Math.min(elapsed / totalDuration, 0.99));
  
        // --- DRAW FRAME ---
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
  
        if (elapsed < NEWS_CONTENT_DURATION) {
            // Video Management
            const videoIndex = Math.floor(elapsed / NEWS_CLIP_DURATION);
            
            if (videoIndex !== currentVideoIndex && videoIndex < videosWithData.length) {
                if (currentVideoIndex >= 0 && videosWithData[currentVideoIndex]) {
                    videosWithData[currentVideoIndex].element.pause();
                }
                const nextVid = videosWithData[videoIndex];
                if (nextVid) {
                    nextVid.element.currentTime = nextVid.startTime;
                    nextVid.element.play().catch(e => console.warn("Auto-play blocked?", e));
                }
                currentVideoIndex = videoIndex;
            }

            const activeData = videosWithData[currentVideoIndex];
            if (activeData) {
                const timeWithinClip = elapsed % NEWS_CLIP_DURATION;
                if (Math.abs(activeData.element.currentTime - (activeData.startTime + timeWithinClip)) > 0.5) {
                     activeData.element.currentTime = activeData.startTime + timeWithinClip;
                }
                drawVideoCover(ctx, activeData.element, 0, 0, WIDTH, HEIGHT);
            }

            // === MODERN GRAPHICS OVERLAY (CNN Style) ===

            // 1. "LIVE" Indicator (Top Right)
            const liveX = WIDTH - 40 - 140;
            const liveY = 60;
            ctx.fillStyle = '#cc0000'; // Deep Red
            ctx.fillRect(liveX, liveY, 140, 50);
            
            // Blinking dot
            if (Math.floor(elapsed * 2) % 2 === 0) {
                ctx.fillStyle = 'white';
                ctx.beginPath();
                ctx.arc(liveX + 25, liveY + 25, 8, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.font = 'bold 30px Arial';
            ctx.fillStyle = 'white';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText("LIVE", liveX + 50, liveY + 26);


            // 2. LOCATION & DATE (Center/Top) - Стиль как на скриншотах
            const headerY = 300;
            
            // Дата в черном блоке с белой обводкой
            if (data.dateLabel) {
                ctx.save();
                ctx.font = 'bold 70px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                
                const dateText = data.dateLabel.toUpperCase();
                const dateTextWidth = ctx.measureText(dateText).width;
                const dateBoxPadding = 40;
                const dateBoxWidth = dateTextWidth + (dateBoxPadding * 2);
                const dateBoxHeight = 100;
                const dateBoxX = (WIDTH - dateBoxWidth) / 2;
                const dateBoxY = headerY - dateBoxHeight / 2;
                
                // Черный блок
                ctx.fillStyle = '#000000';
                ctx.fillRect(dateBoxX, dateBoxY, dateBoxWidth, dateBoxHeight);
                
                // Белая обводка
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 4;
                ctx.strokeRect(dateBoxX, dateBoxY, dateBoxWidth, dateBoxHeight);
                
                // Белый текст
                ctx.fillStyle = '#ffffff';
                ctx.fillText(dateText, WIDTH / 2, headerY);
                
                ctx.restore();
            }
            
            // Страна в красном блоке с белой обводкой
            if (data.countryLabel) {
                ctx.save();
                ctx.font = '900 120px "Arial Black", "Impact", sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                
                const countryText = data.countryLabel.toUpperCase();
                const countryTextWidth = ctx.measureText(countryText).width;
                const countryBoxPadding = 50;
                const countryBoxWidth = countryTextWidth + (countryBoxPadding * 2);
                const countryBoxHeight = 140;
                const countryBoxX = (WIDTH - countryBoxWidth) / 2;
                const countryBoxY = headerY + 80;
                
                // Красный блок
                ctx.fillStyle = '#ef4444'; // Красный
                ctx.fillRect(countryBoxX, countryBoxY, countryBoxWidth, countryBoxHeight);
                
                // Белая обводка
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 5;
                ctx.strokeRect(countryBoxX, countryBoxY, countryBoxWidth, countryBoxHeight);
                
                // Белый текст
                ctx.fillStyle = '#ffffff';
                ctx.fillText(countryText, WIDTH / 2, countryBoxY + countryBoxHeight / 2);
                
                ctx.restore();
            }
            
            // Логотип в правом верхнем углу
            drawLogo(ctx, WIDTH - 220, 40, 180);

            // 3. MODERN LOWER THIRD (News Ticker)
            const tickerInterval = NEWS_CONTENT_DURATION / 3;
            const tickerIndex = Math.floor(elapsed / tickerInterval);
            const currentTicker = data.newsTickers[Math.min(tickerIndex, 2)];
            
            if (currentTicker && tickerIndex < 3) {
                const localTime = elapsed % tickerInterval;
                const fadeDuration = 0.8; 
                
                let alpha = 1;
                let yOffset = 0;

                if (localTime < fadeDuration) {
                    const t = localTime / fadeDuration; 
                    const ease = t * (2 - t);
                    alpha = ease;
                    yOffset = (1 - ease) * 100; 
                } else if (localTime > tickerInterval - fadeDuration) {
                    const t = (tickerInterval - localTime) / fadeDuration; 
                    const ease = t * t;
                    alpha = ease;
                    yOffset = (1 - ease) * 100;
                }

                if (alpha > 0.01) {
                    ctx.save();
                    ctx.globalAlpha = alpha;
                    
                    const barHeight = 280;
                    const baseBarY = HEIGHT - barHeight - 150;
                    const barY = baseBarY + yOffset;
                    
                    // Белая плашка
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, barY, WIDTH, barHeight);

                    // Зеленая иконка кавычек
                    drawQuoteIcon(ctx, 50, barY + 20, 70);

                    // Text
                    ctx.fillStyle = '#000000';
                    ctx.font = 'bold 52px Arial'; 
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'top';
                    
                    const textX = 130;
                    const textY = barY + 50;
                    const maxTextW = WIDTH - 180;

                    const lines = getLines(ctx, currentTicker.toUpperCase(), maxTextW); 
                    lines.forEach((line, i) => {
                        if (i < 3) ctx.fillText(line, textX, textY + (i * 70));
                    });

                    ctx.restore();
                }
            }

            // 4th Plate Logic
            const strictClipIndex = Math.floor(elapsed / 5);
            if (strictClipIndex >= 1 && strictClipIndex <= 4) {
                 let textToShow = "";
                 if (strictClipIndex === 1) textToShow = data.newsTickers[0];
                 if (strictClipIndex === 2) textToShow = data.newsTickers[1];
                 if (strictClipIndex === 3) textToShow = data.newsTickers[2];
                 if (strictClipIndex === 4) textToShow = "ПРОГНОЗ СОБЫТИЙ: ЧТО БУДЕТ ДАЛЬШЕ?";

                 if (textToShow) {
                     const clipLocalTime = elapsed % 5;
                     const fadeDur = 0.5;
                     let alpha = 1;
                     let yOff = 0;

                     if (clipLocalTime < fadeDur) {
                         alpha = clipLocalTime / fadeDur;
                         yOff = (1 - alpha) * 50;
                     } else if (clipLocalTime > 5 - fadeDur) {
                         alpha = (5 - clipLocalTime) / fadeDur;
                         yOff = (1 - alpha) * 50;
                     }
                     
                     if (alpha > 0) {
                         ctx.save();
                         ctx.globalAlpha = alpha;
                         const barH = 280;
                         const drawY = HEIGHT - barH - 150 + yOff;

                         ctx.fillStyle = '#ffffff';
                         ctx.fillRect(0, drawY, WIDTH, barH);
                         
                         drawQuoteIcon(ctx, 50, drawY + 20, 70);
                         
                         ctx.fillStyle = '#000000';
                         ctx.font = 'bold 52px Arial';
                         ctx.textAlign = 'left';
                         ctx.textBaseline = 'top';
                         const lns = getLines(ctx, textToShow.toUpperCase(), WIDTH - 150);
                         lns.forEach((l, i) => { 
                             if(i < 3) ctx.fillText(l, 130, drawY + 50 + (i * 70)); 
                         });

                         ctx.restore();
                     }
                 }
            }

        } else {
          // CTA (Image)
          if (currentVideoIndex >= 0 && videosWithData[currentVideoIndex]) {
             videosWithData[currentVideoIndex].element.pause();
          }
          drawImageCTA(ctx, ctaImageEl, frameCount);
        }
  
        frameCount++;
        requestAnimationFrame(loop);
      };
  
      loop();
    });
  };
