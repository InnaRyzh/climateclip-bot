
import React, { useState, useEffect, useRef } from 'react';
import { TemplateType, GridTemplateData, NewsTemplateData, VideoFile, ProcessingStatus } from './types';
import { renderGridVideo, renderNewsVideo } from './services/compositor';
import { generateNewsTickers } from './services/geminiService';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TemplateType>(TemplateType.GRID_4);
  const [status, setStatus] = useState<ProcessingStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultExt, setResultExt] = useState<string>('webm');

  // Общее поле для CTA Картинки
  const [ctaImage, setCtaImage] = useState<File | null>(null);

  // State for Grid Template
  const [gridVideos, setGridVideos] = useState<[VideoFile | null, VideoFile | null, VideoFile | null, VideoFile | null]>([null, null, null, null]);
  const [gridCountries, setGridCountries] = useState<[string, string, string, string]>(['', '', '', '']);
  const [gridDate, setGridDate] = useState<string>('');

  // State for News Template
  const [newsVideos, setNewsVideos] = useState<VideoFile[]>([]);
  const [newsCountry, setNewsCountry] = useState<string>('');
  const [newsDate, setNewsDate] = useState<string>('');
  const [newsTickers, setNewsTickers] = useState<[string, string, string]>(['', '', '']);
  const [newsTopic, setNewsTopic] = useState<string>('');
  const [isGeneratingAI, setIsGeneratingAI] = useState(false);

  // Helper to handle file upload and get duration
  const handleFileUpload = (files: FileList | null, index: number, isGrid: boolean) => {
    if (!files || files.length === 0) return;
    
    const file = files[0];
    const previewUrl = URL.createObjectURL(file);
    
    // Create temp video to get duration
    const tempVideo = document.createElement('video');
    tempVideo.preload = 'metadata';
    tempVideo.onloadedmetadata = () => {
        const videoFile: VideoFile = {
            id: Math.random().toString(36).substr(2, 9),
            file,
            previewUrl,
            duration: tempVideo.duration,
            startTime: 0,
        };

        if (isGrid) {
          const newVideos = [...gridVideos] as [VideoFile | null, VideoFile | null, VideoFile | null, VideoFile | null];
          newVideos[index] = videoFile;
          setGridVideos(newVideos);
        } else {
          const newVideos = [...newsVideos];
          newVideos[index] = videoFile;
          setNewsVideos(newVideos);
        }
    };
    tempVideo.src = previewUrl;
  };

  const handleCtaUpload = (files: FileList | null) => {
      if (files && files.length > 0) {
          setCtaImage(files[0]);
      }
  };

  const handleStartTimeChange = (index: number, time: number) => {
      const newVideos = [...newsVideos];
      if (newVideos[index]) {
          newVideos[index] = { ...newVideos[index], startTime: time };
          setNewsVideos(newVideos);
          
          // Update preview via DOM manipulation safely
          const vidElement = document.getElementById(`news-preview-${index}`) as HTMLVideoElement;
          if (vidElement) {
              vidElement.currentTime = time;
          }
      }
  };

  // Ensure news videos array has 5 slots
  useEffect(() => {
    if (newsVideos.length < 5) {
      setNewsVideos(prev => {
        const arr = [...prev];
        while(arr.length < 5) arr.push({ id: 'empty', file: new File([], ''), previewUrl: '', duration: 0, startTime: 0 });
        return arr;
      });
    }
  }, []);

  const handleAiGenerate = async () => {
    if (!newsTopic) return;
    setIsGeneratingAI(true);
    const tickers = await generateNewsTickers(newsTopic);
    setNewsTickers([tickers[0] || '', tickers[1] || '', tickers[2] || '']);
    setIsGeneratingAI(false);
  };

  const handleRender = async () => {
    setStatus('processing');
    setProgress(0);
    setResultUrl(null);

    try {
      let blob: Blob;
      console.log('Active tab:', activeTab);
      
      if (activeTab === TemplateType.GRID_4) {
        console.log('Grid videos:', gridVideos);
        const validGridVideos = gridVideos.filter(v => v && v.previewUrl && v.previewUrl !== '');
        console.log('Valid grid videos count:', validGridVideos.length);
        
        if (validGridVideos.length !== 4) {
          alert(`Пожалуйста, загрузите все 4 видео. Загружено: ${validGridVideos.length}`);
          setStatus('idle');
          return;
        }
        
        console.log('Starting grid video render...');
        blob = await renderGridVideo({
          videos: gridVideos,
          countryLabels: gridCountries,
          centerDate: gridDate,
          ctaImage: ctaImage
        }, (p) => setProgress(p));
        console.log('Grid video rendered successfully');
      } else {
        const validVideos = newsVideos.filter(v => v.previewUrl !== '');
        console.log('News videos:', newsVideos);
        console.log('Valid news videos count:', validVideos.length);
        
        if (validVideos.length < 5) {
          alert(`Пожалуйста, загрузите 5 видеофрагментов. Загружено: ${validVideos.length}`);
          setStatus('idle');
          return;
        }
        
        console.log('Starting news video render...');
        blob = await renderNewsVideo({
          videos: validVideos,
          countryLabel: newsCountry,
          dateLabel: newsDate,
          newsTickers: newsTickers,
          ctaImage: ctaImage
        }, (p) => setProgress(p));
        console.log('News video rendered successfully');
      }

      // Determine extension based on blob type
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      setResultExt(ext);

      const url = URL.createObjectURL(blob);
      setResultUrl(url);
      setStatus('completed');
      console.log('Video ready, blob size:', blob.size, 'type:', blob.type);
    } catch (e) {
      console.error('Render error:', e);
      alert(`Ошибка при создании видео: ${e instanceof Error ? e.message : String(e)}. Попробуйте другие файлы или браузер.`);
      setStatus('error');
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 pb-20 font-sans">
      <header className="mb-6 text-center">
        <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-emerald-400">
          ClimateClip Studio
        </h1>
        <p className="text-sm text-slate-400">Автоматический монтаж для Telegram</p>
      </header>

      {/* Tabs */}
      <div className="flex bg-slate-800 rounded-lg p-1 mb-6">
        <button
          onClick={() => setActiveTab(TemplateType.GRID_4)}
          className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${
            activeTab === TemplateType.GRID_4 
              ? 'bg-blue-600 text-white shadow-lg' 
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Шаблон 1: Сетка 4x
        </button>
        <button
          onClick={() => setActiveTab(TemplateType.NEWS_SEQUENCE)}
          className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${
            activeTab === TemplateType.NEWS_SEQUENCE
              ? 'bg-emerald-600 text-white shadow-lg'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Шаблон 2: Новости
        </button>
      </div>

      {/* Content */}
      <div className="max-w-md mx-auto space-y-6">

        {/* Common CTA Upload */}
        <div className="bg-slate-800 p-4 rounded-lg border border-slate-700">
             <div className="flex justify-between items-center mb-2">
                <label className="text-xs font-bold text-slate-400 uppercase">Финальная заставка (Картинка)</label>
                <span className="text-[10px] text-slate-500 bg-slate-900 px-2 py-1 rounded">Обязательно</span>
             </div>
             <label className="block w-full h-24 bg-slate-900 rounded border-2 border-dashed border-slate-700 hover:border-blue-500 cursor-pointer flex flex-col items-center justify-center overflow-hidden relative">
                <input 
                  type="file" 
                  accept="image/*" 
                  className="hidden" 
                  onChange={(e) => handleCtaUpload(e.target.files)}
                />
                {ctaImage ? (
                   <img src={URL.createObjectURL(ctaImage)} className="w-full h-full object-cover opacity-70" />
                ) : (
                   <div className="text-center">
                     <span className="text-xl">🖼️</span>
                     <div className="text-[10px] mt-1 text-slate-500">Загрузить скриншот доклада</div>
                   </div>
                )}
                {ctaImage && <div className="absolute inset-0 flex items-center justify-center font-bold text-shadow">Загружено</div>}
             </label>
        </div>
        
        {/* GRID TEMPLATE FORM */}
        {activeTab === TemplateType.GRID_4 && (
          <div className="space-y-4 animate-fade-in">
            <div className="grid grid-cols-2 gap-3">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="bg-slate-800 rounded-lg p-3 border border-slate-700">
                  <div className="mb-2 text-xs font-bold text-slate-400 uppercase">Секция {i + 1}</div>
                  
                  <label className="block w-full aspect-[9/16] bg-slate-900 rounded border-2 border-dashed border-slate-700 hover:border-blue-500 cursor-pointer flex flex-col items-center justify-center overflow-hidden relative group">
                    <input 
                      type="file" 
                      accept="video/*" 
                      className="hidden" 
                      onChange={(e) => handleFileUpload(e.target.files, i, true)}
                    />
                    {gridVideos[i] ? (
                      <video src={gridVideos[i]!.previewUrl} className="w-full h-full object-cover" muted loop autoPlay />
                    ) : (
                      <div className="text-center p-2">
                        <span className="text-2xl">📹</span>
                        <div className="text-[10px] mt-1 text-slate-500">Загрузить</div>
                      </div>
                    )}
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <span className="text-white text-xs">Изменить</span>
                    </div>
                  </label>

                  <input
                    type="text"
                    placeholder="Страна"
                    value={gridCountries[i]}
                    onChange={(e) => {
                      const newC = [...gridCountries] as [string, string, string, string];
                      newC[i] = e.target.value;
                      setGridCountries(newC);
                    }}
                    className="mt-2 w-full bg-slate-700 border-none rounded px-2 py-1 text-xs text-white placeholder-slate-500 focus:ring-1 focus:ring-blue-500 outline-none"
                  />
                </div>
              ))}
            </div>

            <div className="bg-slate-800 p-4 rounded-lg border border-slate-700">
              <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Центральная дата/описание</label>
              <input
                type="text"
                placeholder="Например: 12 Октября 2023"
                value={gridDate}
                onChange={(e) => setGridDate(e.target.value)}
                className="w-full bg-slate-700 border-none rounded px-3 py-2 text-sm text-white focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
          </div>
        )}

        {/* NEWS TEMPLATE FORM */}
        {activeTab === TemplateType.NEWS_SEQUENCE && (
          <div className="space-y-6 animate-fade-in">
            
            {/* Country & Date */}
            <div className="grid grid-cols-2 gap-3">
               <div className="bg-slate-800 p-4 rounded-lg border border-slate-700">
                <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Страна</label>
                <input
                  type="text"
                  value={newsCountry}
                  onChange={(e) => setNewsCountry(e.target.value)}
                  className="w-full bg-slate-700 border-none rounded px-3 py-2 text-sm text-white focus:ring-2 focus:ring-emerald-500 outline-none"
                  placeholder="ИНДОНЕЗИЯ"
                />
              </div>
               <div className="bg-slate-800 p-4 rounded-lg border border-slate-700">
                <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Дата</label>
                <input
                  type="text"
                  value={newsDate}
                  onChange={(e) => setNewsDate(e.target.value)}
                  className="w-full bg-slate-700 border-none rounded px-3 py-2 text-sm text-white focus:ring-2 focus:ring-emerald-500 outline-none"
                  placeholder="2-3 декабря"
                />
              </div>
            </div>

            {/* Videos with Trimmer */}
            <div className="space-y-4">
              <label className="block text-xs font-bold text-slate-400 uppercase">5 Видеофрагментов (по 5 сек)</label>
              
              {newsVideos.map((video, i) => (
                  <div key={i} className="bg-slate-800 p-3 rounded-lg border border-slate-700 flex gap-3">
                      <div className="w-20 h-28 flex-shrink-0 relative">
                        <label className="block w-full h-full bg-slate-900 rounded cursor-pointer overflow-hidden border border-slate-600 hover:border-emerald-500">
                             <input 
                                type="file" 
                                accept="video/*" 
                                className="hidden" 
                                onChange={(e) => handleFileUpload(e.target.files, i, false)}
                              />
                             {video.previewUrl ? (
                                 <video 
                                    id={`news-preview-${i}`}
                                    src={video.previewUrl} 
                                    className="w-full h-full object-cover" 
                                    muted 
                                    // Removed autoPlay so we can control preview frame with slider
                                 />
                             ) : (
                                <div className="flex items-center justify-center h-full text-slate-600 font-bold">{i+1}</div>
                             )}
                        </label>
                      </div>

                      <div className="flex-1 flex flex-col justify-center">
                          {!video.previewUrl ? (
                              <div className="text-xs text-slate-500">Загрузите видеофайл</div>
                          ) : (
                              <div>
                                  <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                                      <span>Старт: {video.startTime.toFixed(1)}с</span>
                                      <span>Длит: 5.0с</span>
                                  </div>
                                  <input 
                                    type="range"
                                    min="0"
                                    max={Math.max(0, video.duration - 5)}
                                    step="0.1"
                                    value={video.startTime}
                                    onChange={(e) => handleStartTimeChange(i, parseFloat(e.target.value))}
                                    className="w-full accent-emerald-500 h-2 bg-slate-900 rounded-lg appearance-none cursor-pointer"
                                  />
                                  <div className="flex justify-between text-[10px] text-slate-600 mt-1">
                                      <span>0c</span>
                                      <span>{(video.duration).toFixed(1)}c</span>
                                  </div>
                                  <p className="text-[10px] text-slate-500 mt-2">
                                      Передвиньте ползунок, чтобы выбрать момент.
                                  </p>
                              </div>
                          )}
                      </div>
                  </div>
              ))}
            </div>

            {/* AI Generation */}
            <div className="bg-slate-800 p-4 rounded-lg border border-slate-700 relative overflow-hidden">
              <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Текст плашек (Описание)</label>
              <div className="flex gap-2 mb-4">
                <input
                  type="text"
                  placeholder="Тема происшествия..."
                  value={newsTopic}
                  onChange={(e) => setNewsTopic(e.target.value)}
                  className="flex-1 bg-slate-700 border-none rounded px-3 py-2 text-sm text-white focus:ring-2 focus:ring-emerald-500 outline-none"
                />
                <button
                  onClick={handleAiGenerate}
                  disabled={isGeneratingAI}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50 flex items-center"
                >
                  {isGeneratingAI ? '...' : '✨ AI'}
                </button>
              </div>

              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <textarea
                    key={i}
                    placeholder={`Описание факта ${i + 1}`}
                    value={newsTickers[i]}
                    onChange={(e) => {
                      const newT = [...newsTickers] as [string, string, string];
                      newT[i] = e.target.value;
                      setNewsTickers(newT);
                    }}
                    rows={2}
                    className="w-full bg-slate-900/50 border border-slate-700 rounded px-3 py-2 text-xs text-emerald-100 outline-none focus:border-emerald-500 transition-colors resize-none"
                  />
                ))}
              </div>
            </div>

          </div>
        )}

        {/* Action Area */}
        <div className="pt-4 border-t border-slate-800">
          {status === 'processing' ? (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-slate-400">
                <span>Рендеринг...</span>
                <span>{Math.round(progress * 100)}%</span>
              </div>
              <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                <div 
                  className="bg-gradient-to-r from-blue-500 to-purple-500 h-full transition-all duration-300"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
              <p className="text-center text-xs text-slate-500 mt-2">Не закрывайте приложение</p>
            </div>
          ) : status === 'completed' && resultUrl ? (
            <div className="text-center space-y-4 animate-bounce-in">
              <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-lg">
                <p className="text-green-400 font-medium mb-3">✅ Видео готово!</p>
                <a 
                  href={resultUrl} 
                  download={`climate_clip_${Date.now()}.${resultExt}`}
                  className="inline-block w-full bg-green-600 hover:bg-green-500 text-white font-bold py-3 px-4 rounded-lg shadow-lg transition-transform transform hover:scale-[1.02]"
                >
                  Скачать видео ({resultExt.toUpperCase()})
                </a>
              </div>
              <button 
                onClick={() => setStatus('idle')}
                className="text-slate-400 text-sm hover:text-white underline"
              >
                Создать еще одно
              </button>
            </div>
          ) : (
            <button
              onClick={handleRender}
              className={`w-full py-4 rounded-xl font-bold text-lg shadow-lg transition-all transform hover:scale-[1.01] ${
                activeTab === TemplateType.GRID_4 
                  ? 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white'
                  : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white'
              }`}
            >
              Создать видео
            </button>
          )}
        </div>

      </div>
    </div>
  );
};

export default App;
