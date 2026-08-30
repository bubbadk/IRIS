import { describe, expect, it } from 'vitest';
import { resolveWorkspaceIntent } from '@iris/cortex';

describe('IRIS workspace intent', () => {
  it('opens the models object from natural language', () => {
    expect(resolveWorkspaceIntent('show me my models')).toBe('models');
  });

  it('opens the projects object for task-oriented workspace intent', () => {
    expect(resolveWorkspaceIntent('open my project tasks')).toBe('projects');
  });

  it('opens the workspace object for local file intent', () => {
    expect(resolveWorkspaceIntent('show my local files')).toBe('workspace');
  });

  it('does not pretend unknown commands are supported', () => {
    expect(resolveWorkspaceIntent('deploy my production cluster')).toBeNull();
  });
});
