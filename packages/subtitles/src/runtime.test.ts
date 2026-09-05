import { describe, expect, it } from 'vitest';
import { parseSubtitles } from './parser';
import { SubtitleRuntime, type SubtitleSession } from './runtime';

const file = parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n');
const settings = { providerId: 'provider', model: 'model', targetLanguage: 'Danish', chunkSize: 25 };

describe('subtitle runtime continuity', () => {
  it('keeps running without a view and persists a resumable partial checkpoint', async () => {
    let saved: SubtitleSession | undefined;
    const runtime = new SubtitleRuntime((snapshot) => { saved = structuredClone(snapshot); });
    runtime.load('dialogue.srt', file);
    const unsubscribe = runtime.subscribe(() => undefined);
    unsubscribe();
    await runtime.start(settings, async () => '[{"id":1,"text":"Hej"}]');
    expect(saved?.progress.status).toBe('failed');
    expect(saved?.progress.translatedCuesCount).toBe(1);
    const restored = new SubtitleRuntime(() => undefined, saved);
    await restored.start(settings, async () => '[{"id":2,"text":"Farvel"}]');
    expect(restored.getSnapshot().progress.status).toBe('completed');
    expect(restored.getSnapshot().translated).toEqual([[1, 'Hej'], [2, 'Farvel']]);
  });

  it('never applies a late response after reset', async () => {
    const runtime = new SubtitleRuntime(() => undefined);
    runtime.load('dialogue.srt', file);
    let finish: (text: string) => void = () => undefined;
    const run = runtime.start(settings, () => new Promise((resolve) => { finish = resolve; }));
    runtime.reset();
    finish('[{"id":1,"text":"Hej"},{"id":2,"text":"Farvel"}]');
    await run;
    expect(runtime.getSnapshot().parsedFile).toBeNull();
    expect(runtime.getSnapshot().translated).toEqual([]);
  });

  it('stops before provider work if its checkpoint cannot be saved', async () => {
    let fail = false;
    const runtime = new SubtitleRuntime(() => { if (fail) throw new Error('Storage full'); });
    runtime.load('dialogue.srt', file);
    fail = true;
    let requests = 0;
    await runtime.start(settings, async () => { requests++; return ''; });
    expect(requests).toBe(0);
    expect(runtime.getSnapshot().progress.error).toContain('Checkpoint could not be saved');
  });
});
