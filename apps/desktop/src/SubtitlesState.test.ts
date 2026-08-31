import { describe, expect, it } from 'vitest';
import { defaultWindow } from './windowing';
import { resolveWorkspaceIntent } from '@iris/cortex';

describe('Subtitle Window & Intent Integration', () => {
  it('configures default window for subtitles studio', () => {
    const win = defaultWindow('subtitles', 1);
    expect(win.objectType).toBe('subtitles');
    expect(win.title).toBe('Subtitle Studio');
    expect(win.width).toBe(880);
    expect(win.height).toBe(580);
  });

  it('routes subtitle translation intent to subtitles stage', () => {
    expect(resolveWorkspaceIntent('oversæt undertekster')).toBe('subtitles');
    expect(resolveWorkspaceIntent('translate srt file to danish')).toBe('subtitles');
  });
});
