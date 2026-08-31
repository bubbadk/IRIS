import type { SubtitleCue, TranslationChunk } from './types';

export function createTranslationChunks(
  cues: SubtitleCue[],
  chunkSize = 25,
  contextSize = 3,
): TranslationChunk[] {
  if (cues.length === 0) return [];
  const safeChunkSize = Math.max(1, chunkSize);
  const totalChunks = Math.ceil(cues.length / safeChunkSize);
  const chunks: TranslationChunk[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const startIndex = i * safeChunkSize;
    const endIndex = Math.min(startIndex + safeChunkSize, cues.length);
    const chunkCues = cues.slice(startIndex, endIndex);

    const contextStart = Math.max(0, startIndex - contextSize);
    const contextCues = cues.slice(contextStart, startIndex);

    chunks.push({
      chunkIndex: i + 1,
      totalChunks,
      cues: chunkCues,
      contextCues,
    });
  }

  return chunks;
}
