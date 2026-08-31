import { describe, expect, it } from 'vitest';
import {
  parseSubtitles,
  detectSubtitleFormat,
  reassembleSubtitles,
  createTranslationChunks,
  buildChunkTranslationPrompt,
  parseChunkTranslationResponse,
} from './index';

const sampleSrt = `1
00:00:01,000 --> 00:00:04,000
Hello world, welcome to IRIS.

2
00:00:05,200 --> 00:00:08,450
<i>This is a subtitle with formatting.</i>
Second line of subtitle.

3
00:00:09,000 --> 00:00:12,000
Goodbye for now!
`;

const sampleVtt = `WEBVTT - Sample File

1
00:00:01.000 --> 00:00:04.000 position:10%,line:90%
Hello world, welcome to IRIS.

2
00:00:05.200 --> 00:00:08.450
<i>This is a subtitle with formatting.</i>
Second line of subtitle.
`;

describe('Subtitle Parser', () => {
  it('detects SRT format correctly', () => {
    expect(detectSubtitleFormat(sampleSrt)).toBe('srt');
  });

  it('detects VTT format correctly', () => {
    expect(detectSubtitleFormat(sampleVtt)).toBe('vtt');
  });

  it('parses SRT cues with timestamps and formatting', () => {
    const parsed = parseSubtitles(sampleSrt);
    expect(parsed.format).toBe('srt');
    expect(parsed.cues).toHaveLength(3);

    expect(parsed.cues[0]).toMatchObject({
      id: 1,
      startTime: '00:00:01,000',
      endTime: '00:00:04,000',
      text: 'Hello world, welcome to IRIS.',
    });

    expect(parsed.cues[1]).toMatchObject({
      id: 2,
      startTime: '00:00:05,200',
      endTime: '00:00:08,450',
      text: '<i>This is a subtitle with formatting.</i>\nSecond line of subtitle.',
    });
  });

  it('parses WebVTT header, settings and cues', () => {
    const parsed = parseSubtitles(sampleVtt);
    expect(parsed.format).toBe('vtt');
    expect(parsed.header).toContain('WEBVTT');
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.cues[0].startTime).toBe('00:00:01.000');
    expect(parsed.cues[0].settings).toBe('position:10%,line:90%');
  });
});

describe('Subtitle Reassembler', () => {
  it('reassembles SRT with translated text while keeping timestamps exact', () => {
    const parsed = parseSubtitles(sampleSrt);
    const translatedMap = new Map<number, string>([
      [1, 'Hej verden, velkommen til IRIS.'],
      [2, '<i>Dette er en undertekst med formatering.</i>\nAnden linje af underteksten.'],
      [3, 'Farvel for nu!'],
    ]);

    const result = reassembleSubtitles(parsed, translatedMap);
    expect(result).toContain('1\n00:00:01,000 --> 00:00:04,000\nHej verden, velkommen til IRIS.');
    expect(result).toContain('2\n00:00:05,200 --> 00:00:08,450\n<i>Dette er en undertekst med formatering.</i>\nAnden linje af underteksten.');
    expect(result).toContain('3\n00:00:09,000 --> 00:00:12,000\nFarvel for nu!');
  });

  it('reassembles VTT with header and settings', () => {
    const parsed = parseSubtitles(sampleVtt);
    const translatedMap = new Map<number, string>([
      [1, 'Hej verden, velkommen til IRIS.'],
    ]);

    const result = reassembleSubtitles(parsed, translatedMap);
    expect(result).toContain('WEBVTT');
    expect(result).toContain('00:00:01.000 --> 00:00:04.000 position:10%,line:90%');
    expect(result).toContain('Hej verden, velkommen til IRIS.');
  });
});

describe('Subtitle Chunker & Prompt Builder', () => {
  it('chunks cues into batches with sliding context', () => {
    const parsed = parseSubtitles(sampleSrt);
    const chunks = createTranslationChunks(parsed.cues, 2, 1);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].chunkIndex).toBe(1);
    expect(chunks[0].cues).toHaveLength(2);
    expect(chunks[0].contextCues).toHaveLength(0);

    expect(chunks[1].chunkIndex).toBe(2);
    expect(chunks[1].cues).toHaveLength(1);
    expect(chunks[1].contextCues).toHaveLength(1);
    expect(chunks[1].contextCues[0].id).toBe(2);
  });

  it('builds clear translation prompt with guidelines', () => {
    const parsed = parseSubtitles(sampleSrt);
    const chunks = createTranslationChunks(parsed.cues, 2, 1);
    const prompt = buildChunkTranslationPrompt(chunks[1], { targetLanguage: 'Dansk (Danish)' });

    expect(prompt).toContain('Dansk (Danish)');
    expect(prompt).toContain('FORRIGE DIALOG-KONTEKST');
    expect(prompt).toContain('UNDERTEKSTER DER SKAL OVERSÆTTES');
  });

  it('parses JSON response correctly even with markdown fences', () => {
    const rawResponse = `Her er oversættelsen:
\`\`\`json
[
  { "id": 1, "text": "Hej verden" },
  { "id": 2, "text": "Anden linje" }
]
\`\`\``;

    const parsed = parseChunkTranslationResponse(rawResponse, [1, 2]);
    expect(parsed.get(1)).toBe('Hej verden');
    expect(parsed.get(2)).toBe('Anden linje');
  });
});
