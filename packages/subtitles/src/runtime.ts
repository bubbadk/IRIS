import { createTranslationChunks } from './chunker';
import { buildChunkTranslationPrompt, parseChunkTranslationResponse } from './prompt';
import type { ParsedSubtitleFile, TranslationOptions, TranslationProgress } from './types';

export interface TranslationSettings extends TranslationOptions {
  providerId: string;
  model: string;
}

export interface SubtitleSession {
  version: 1;
  fileName: string;
  parsedFile: ParsedSubtitleFile | null;
  translated: [number, string][];
  progress: TranslationProgress;
  activeCueId: number | null;
  settings?: TranslationSettings;
}

export const emptySubtitleSession = (): SubtitleSession => ({
  version: 1, fileName: '', parsedFile: null, translated: [], activeCueId: null,
  progress: { status: 'idle', currentChunk: 0, totalChunks: 0, translatedCuesCount: 0, totalCuesCount: 0, percent: 0 },
});

export class SubtitleRuntime {
  private snapshot: SubtitleSession;
  private controller: AbortController | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly save: (session: SubtitleSession) => void, restored?: SubtitleSession) {
    this.snapshot = restored ? structuredClone(restored) : emptySubtitleSession();
    if (this.snapshot.progress.status === 'translating') {
      this.snapshot.progress = { ...this.snapshot.progress, status: 'paused' };
      this.snapshot.activeCueId = null;
    }
  }

  getSnapshot = (): SubtitleSession => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(next: SubtitleSession): void {
    try { this.save(next); }
    catch (error) {
      this.controller?.abort();
      next = { ...next, progress: { ...next.progress, status: 'failed', error: `Checkpoint could not be saved: ${error instanceof Error ? error.message : String(error)}. Export the current result before closing IRIS.` } };
    }
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }

  load(fileName: string, parsedFile: ParsedSubtitleFile): void {
    this.controller?.abort();
    this.controller = null;
    this.publish({ ...emptySubtitleSession(), fileName, parsedFile, progress: { ...emptySubtitleSession().progress, totalCuesCount: parsedFile.cues.length } });
  }

  reset(): void {
    this.controller?.abort();
    this.controller = null;
    this.publish(emptySubtitleSession());
  }

  pause(): void {
    if (!this.controller) return;
    this.controller.abort();
    this.controller = null;
    this.publish({ ...this.snapshot, activeCueId: null, progress: { ...this.snapshot.progress, status: 'paused' } });
  }

  async start(settings: TranslationSettings, generate: (prompt: string, signal: AbortSignal) => Promise<string>): Promise<void> {
    if (this.controller) throw new Error('A subtitle translation is already running.');
    const file = this.snapshot.parsedFile;
    if (!file?.cues.length) throw new Error('Load a subtitle file before translating.');
    if (this.snapshot.translated.length && this.snapshot.settings?.targetLanguage !== settings.targetLanguage) {
      throw new Error('Reset or load the file again before changing the target language of a partial translation.');
    }
    const controller = new AbortController();
    this.controller = controller;
    const stale = () => this.controller !== controller || controller.signal.aborted;
    const chunks = createTranslationChunks(file.cues, settings.chunkSize ?? 25, 3);
    const translated = new Map(this.snapshot.translated);
    const checkpoint = (status: TranslationProgress['status'], currentChunk: number, activeCueId: number | null, error?: string) => {
      this.publish({ ...this.snapshot, settings, translated: [...translated], activeCueId, progress: {
        status, currentChunk, totalChunks: chunks.length, totalCuesCount: file.cues.length,
        translatedCuesCount: translated.size, percent: Math.round(translated.size / file.cues.length * 100), error,
      } });
    };
    try {
      checkpoint('translating', 0, null);
      for (const [index, chunk] of chunks.entries()) {
        if (stale()) return;
        if (chunk.cues.every((cue) => translated.has(cue.id))) continue;
        checkpoint('translating', index + 1, chunk.cues[0]?.id ?? null);
        let lastError = 'The model did not translate every requested cue.';
        for (let attempt = 0; attempt < 2; attempt++) {
          if (stale()) return;
          try {
            const response = await generate(buildChunkTranslationPrompt(chunk, settings), controller.signal);
            if (stale()) return;
            const parsed = parseChunkTranslationResponse(response, chunk.cues.map((cue) => cue.id));
            for (const cue of chunk.cues) {
              const text = parsed.get(cue.id);
              if (text && !translated.has(cue.id)) translated.set(cue.id, text);
            }
          } catch (error) {
            if (stale()) return;
            lastError = error instanceof Error ? error.message : String(error);
          }
          checkpoint('translating', index + 1, chunk.cues[0]?.id ?? null);
          if (chunk.cues.every((cue) => translated.has(cue.id))) break;
        }
        if (stale()) return;
        if (chunk.cues.some((cue) => !translated.has(cue.id))) {
          checkpoint('failed', index + 1, null, `${lastError} Partial progress was saved; resume to retry missing cues. Untranslated cues retain their original text when exported.`);
          return;
        }
      }
      if (!stale()) checkpoint('completed', chunks.length, null);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
