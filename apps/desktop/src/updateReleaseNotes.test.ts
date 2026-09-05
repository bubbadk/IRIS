import { describe, expect, it } from 'vitest';
import { readableReleaseNotes, hasReleaseSummary, verifyUpdateTarget } from './updateReleaseNotes';

describe('update disclosure', () => {
  it('renders publisher markdown as readable text', () => {
    expect(readableReleaseNotes('## Changes\n- **Fixed** lost conversations\n- See [details](https://example.com) and `logs`.'))
      .toBe('Changes\n• Fixed lost conversations\n• See details and logs.');
  });
  it('rejects missing notes, generic notices and compare-only links', () => {
    for (const notes of ['', 'See release notes on GitHub.', '[Full Changelog](https://github.com/a/b/compare/v1...v2)', 'IRIS v0.2.10']) {
      expect(hasReleaseSummary(notes, '0.2.10')).toBe(false);
    }
  });
  it('blocks a changed target before any installation is allowed', () => {
    const release = { version: '0.2.11', notes: '- Fixed concurrent memory writes and preserved conversation history.' };
    expect(() => verifyUpdateTarget(release, '0.2.12')).toThrow('target changed');
    expect(() => verifyUpdateTarget({ ...release, notes: '' }, '0.2.11')).toThrow('no usable release summary');
    expect(() => verifyUpdateTarget(release, '0.2.11')).not.toThrow();
  });
});
