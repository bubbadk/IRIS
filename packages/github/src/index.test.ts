import { describe, expect, it, vi } from 'vitest';
import { bumpSemVer, generateChangelogEntry, generateReleaseNotes, generateProjectScaffolding } from './versioning';
import { GitHubService } from './service';
import type { NewProjectDraft } from './types';

describe('packages/github - versioning', () => {
  it('bumps SemVer versions correctly', () => {
    expect(bumpSemVer('0.1.0', 'patch')).toBe('0.1.1');
    expect(bumpSemVer('v0.1.0', 'minor')).toBe('v0.2.0');
    expect(bumpSemVer('v1.2.3', 'major')).toBe('v2.0.0');
    expect(bumpSemVer('1.0', 'patch')).toBe('1.0.1');
  });

  it('generates structured changelog entries', () => {
    const changelog = generateChangelogEntry(
      '0.2.0',
      [
        { type: 'feat', description: 'Add GitHub Operating Environment and dock window' },
        { type: 'fix', description: 'Resolve token validation issue' },
      ],
      '2026-08-31'
    );

    expect(changelog).toContain('## [v0.2.0] - 2026-08-31');
    expect(changelog).toContain('### Features');
    expect(changelog).toContain('- Add GitHub Operating Environment and dock window');
    expect(changelog).toContain('### Bug Fixes');
    expect(changelog).toContain('- Resolve token validation issue');
  });

  it('generates release notes with binary build notice', () => {
    const notes = generateReleaseNotes('v0.2.0', 'Key highlights for v0.2.0', ['iris-linux-x86_64.tar.gz', 'iris.AppImage']);
    expect(notes).toContain('# Release v0.2.0');
    expect(notes).toContain('Key highlights for v0.2.0');
    expect(notes).toContain('- `iris-linux-x86_64.tar.gz`');
    expect(notes).toContain('- `iris.AppImage`');
  });

  it('generates project scaffolding files', () => {
    const draft: NewProjectDraft = {
      name: 'my-super-app',
      description: 'An AI assistant project',
      website: 'https://example.com',
      topics: ['ai', 'agent', 'automation'],
      license: 'MIT',
      setupActionsWorkflow: true,
    };

    const files = generateProjectScaffolding(draft);
    expect(files.some((f) => f.path === 'README.md')).toBe(true);
    expect(files.some((f) => f.path === '.gitignore')).toBe(true);
    expect(files.some((f) => f.path === 'LICENSE')).toBe(true);
    expect(files.some((f) => f.path === '.github/workflows/release.yml')).toBe(true);

    const readme = files.find((f) => f.path === 'README.md')!.content;
    expect(readme).toContain('# my-super-app');
    expect(readme).toContain('An AI assistant project');
  });
});

describe('packages/github - service', () => {
  it('reports unauthenticated when token is empty', async () => {
    const service = new GitHubService('');
    const status = await service.validateAuth();
    expect(status.authenticated).toBe(false);
    expect(status.error).toContain('No GitHub token configured');
  });

  it('handles token change', () => {
    const service = new GitHubService('token-1');
    expect(service.getToken()).toBe('token-1');
    service.setToken('token-2');
    expect(service.getToken()).toBe('token-2');
  });
});
