export interface Note {
  id: string;
  sourceUrl?: string;
  title: string;
  content?: string;
  rawContent?: string;
  ocrText?: string;
  coverUrl: string;
  imageUrls?: string[];
  sourceImageUrls?: string[];
  imageOcr?: Array<{
    imageUrl: string;
    text: string;
    error?: string;
  }>;
  sourceVideoUrl?: string;
  videoUrl?: string;
  videoDuration?: number;
  transcriptText?: string;
  transcriptSegments?: Array<{
    start: number;
    duration: number;
    text: string;
  }>;
  transcriptSkipped?: boolean;
  videoStatus?: 'pending' | 'ready' | 'partial' | 'none';
  videoError?: string;
  mediaStatus?: 'pending' | 'ready' | 'partial' | 'none';
  mediaError?: string;
  author: {
    name: string;
    avatar?: string;
    userId?: string;
  };
  likes: number;
  collects: number;
  comments: number;
  category: string;
  savedAt: Date;
  tags: string[];
  type?: 'video' | 'normal';
  imageAspect?: 'tall' | 'medium' | 'short' | 'normal';
}

export interface XHSUser {
  userId: string;
  nickname: string;
  avatar: string;
  following: number;
  followers: number;
}

export interface AppState {
  notes: Note[];
  isLoading: boolean;
  error: string | null;
}

export type AppAction =
  | { type: 'SET_NOTES'; payload: Note[] }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string | null };
