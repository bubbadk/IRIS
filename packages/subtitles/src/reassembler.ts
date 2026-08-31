import type { ParsedSubtitleFile } from './types';

export function reassembleSubtitles(
  file: ParsedSubtitleFile,
  translatedMap: Map<number, string> | Record<number, string>,
): string {
  const isMap = translatedMap instanceof Map;
  const getTranslated = (id: number): string | undefined =>
    isMap ? translatedMap.get(id) : translatedMap[id];

  const blocks: string[] = [];

  if (file.format === 'vtt') {
    blocks.push(file.header || 'WEBVTT');
  }

  for (let i = 0; i < file.cues.length; i++) {
    const cue = file.cues[i];
    const translatedText = getTranslated(cue.id);
    const textToUse = translatedText !== undefined && translatedText.trim().length > 0 ? translatedText.trim() : cue.text;

    const blockLines: string[] = [];

    if (file.format === 'srt') {
      blockLines.push(String(i + 1));
      blockLines.push(cue.rawTimeLine);
      blockLines.push(textToUse);
    } else {
      // VTT format
      if (cue.identifier) {
        blockLines.push(cue.identifier);
      }
      blockLines.push(cue.rawTimeLine);
      blockLines.push(textToUse);
    }

    blocks.push(blockLines.join('\n'));
  }

  return blocks.join('\n\n') + '\n';
}
