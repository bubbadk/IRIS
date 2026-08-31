import type { ParsedSubtitleFile, SubtitleCue, SubtitleFormat } from './types';

const timestampRegex =
  /(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})/;

export function detectSubtitleFormat(content: string): SubtitleFormat {
  const clean = content.replace(/^\uFEFF/, '').trimStart();
  return clean.startsWith('WEBVTT') ? 'vtt' : 'srt';
}

export function parseSubtitles(rawContent: string): ParsedSubtitleFile {
  const cleanContent = rawContent.replace(/^\uFEFF/, '');
  const format = detectSubtitleFormat(cleanContent);
  const normalized = cleanContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  let header: string | undefined;
  let bodyContent = normalized;

  if (format === 'vtt') {
    const vttHeaderMatch = normalized.match(/^(WEBVTT[^\n]*(?:\n[^\n]+)*\n\n)([\s\S]*)$/);
    if (vttHeaderMatch) {
      header = vttHeaderMatch[1].trimEnd();
      bodyContent = vttHeaderMatch[2];
    } else if (normalized.startsWith('WEBVTT')) {
      const firstDoubleNewline = normalized.indexOf('\n\n');
      if (firstDoubleNewline !== -1) {
        header = normalized.slice(0, firstDoubleNewline).trimEnd();
        bodyContent = normalized.slice(firstDoubleNewline + 2);
      }
    }
  }

  const rawBlocks = bodyContent.split(/\n\n+/);
  const cues: SubtitleCue[] = [];
  let currentId = 1;

  for (const block of rawBlocks) {
    const lines = block.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    // Look for the timestamp line
    let timeLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (timestampRegex.test(lines[i])) {
        timeLineIndex = i;
        break;
      }
    }

    if (timeLineIndex === -1) {
      // Not a valid subtitle cue (could be comments or notes in VTT)
      continue;
    }

    let identifier: string | undefined;
    if (timeLineIndex > 0) {
      identifier = lines.slice(0, timeLineIndex).join('\n').trim();
    }

    const rawTimeLine = lines[timeLineIndex].trim();
    const timeMatch = rawTimeLine.match(
      /((?:(?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3}))\s*-->\s*((?:(?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3}))(?:\s+(.*))?/,
    );

    const startTime = timeMatch?.[1] ?? '';
    const endTime = timeMatch?.[2] ?? '';
    const settings = timeMatch?.[3]?.trim();

    const textLines = lines.slice(timeLineIndex + 1);
    const text = textLines.join('\n').trim();

    cues.push({
      id: currentId,
      startTime,
      endTime,
      rawTimeLine,
      text,
      identifier,
      settings,
    });

    currentId += 1;
  }

  return {
    format,
    header,
    cues,
  };
}
