export type SubtitleFormat = 'srt' | 'vtt';

export interface SubtitleCue {
  /** Sequential index ID starting from 1 */
  id: number;
  /** Raw start timestamp string, e.g. "00:01:20,123" or "00:01:20.123" */
  startTime: string;
  /** Raw end timestamp string, e.g. "00:01:23,456" or "00:01:23.456" */
  endTime: string;
  /** Complete raw time line including arrow and optional cue settings */
  rawTimeLine: string;
  /** Subtitle dialogue text (may contain newlines and inline formatting like <i>) */
  text: string;
  /** Optional VTT identifier or settings */
  identifier?: string;
  settings?: string;
}

export interface ParsedSubtitleFile {
  format: SubtitleFormat;
  header?: string;
  cues: SubtitleCue[];
}

export interface TranslationChunk {
  chunkIndex: number;
  totalChunks: number;
  /** The cues to be translated in this batch */
  cues: SubtitleCue[];
  /** 1-3 preceding cues provided strictly as context for dialogue continuity */
  contextCues: SubtitleCue[];
}

export interface TranslatedCueItem {
  id: number;
  text: string;
}

export interface TranslationOptions {
  sourceLanguage?: string;
  targetLanguage: string;
  chunkSize?: number;
  contextSize?: number;
  customInstructions?: string;
  maxCharsPerLine?: number;
}

export interface TranslationProgress {
  status: 'idle' | 'translating' | 'completed' | 'paused' | 'failed';
  currentChunk: number;
  totalChunks: number;
  translatedCuesCount: number;
  totalCuesCount: number;
  percent: number;
  error?: string;
}
