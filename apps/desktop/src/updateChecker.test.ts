import { describe, expect, it } from 'vitest';
import { isNewerVersion, parseSemver, checkLatestRelease } from './updateChecker';

describe('updateChecker', () => {
  it('parses semver correctly', () => {
    expect(parseSemver('0.1.0')).toEqual([0, 1, 0]);
    expect(parseSemver('v1.2.3-alpha')).toEqual([1, 2, 3]);
  });

  it('detects newer versions correctly', () => {
    expect(isNewerVersion('0.1.0', '0.1.1')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '1.0.0')).toBe(true);
    expect(isNewerVersion('0.2.0', '0.1.9')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
  });

  it('fetches and returns release info when a newer release exists', async () => {
    const mockFetcher = async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v0.2.0',
          name: 'IRIS v0.2.0 · Spatial Cortex Upgrade',
          body: '- Added new live widget\n- Improved memory retrieval',
          html_url: 'https://github.com/iris-systems/iris/releases/tag/v0.2.0',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    const release = await checkLatestRelease('iris-systems/iris', mockFetcher as unknown as typeof fetch);
    expect(release).not.toBeNull();
    expect(release?.version).toBe('0.2.0');
    expect(release?.name).toBe('IRIS v0.2.0 · Spatial Cortex Upgrade');
    expect(release?.notes).toContain('Added new live widget');
  });

  it('returns null when current version is up to date', async () => {
    const mockFetcher = async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v0.1.0',
          name: 'IRIS v0.1.0',
          body: 'Initial release',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    const release = await checkLatestRelease('iris-systems/iris', mockFetcher as unknown as typeof fetch);
    expect(release).toBeNull();
  });
});
