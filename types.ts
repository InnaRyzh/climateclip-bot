
export enum TemplateType {
  GRID_4 = 'GRID_4',
  NEWS_SEQUENCE = 'NEWS_SEQUENCE',
}

export interface VideoFile {
  id: string;
  file: File;
  previewUrl: string;
  duration: number; // Общая длительность исходника
  startTime: number; // С какой секунды начинать (для обрезки)
}

export interface GridTemplateData {
  videos: [VideoFile | null, VideoFile | null, VideoFile | null, VideoFile | null];
  countryLabels: [string, string, string, string];
  centerDate: string;
  ctaImage?: File | null; // Пользовательская картинка для концовки
}

export interface NewsTemplateData {
  videos: VideoFile[];
  countryLabel: string;
  dateLabel: string;
  newsTickers: [string, string, string];
  ctaImage?: File | null; // Пользовательская картинка для концовки
}

export type ProcessingStatus = 'idle' | 'processing' | 'completed' | 'error';
