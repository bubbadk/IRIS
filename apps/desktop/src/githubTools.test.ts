import { describe, expect, it } from 'vitest';
import { createAllGitHubTools } from './githubTools';

describe('apps/desktop - githubTools', () => {
  it('creates all github tools with valid risk and descriptions', () => {
    const tools = createAllGitHubTools();
    expect(tools.length).toBe(8);

    const ids = tools.map((t) => t.id);
    expect(ids).toContain('github.list_repos');
    expect(ids).toContain('github.get_repo');
    expect(ids).toContain('github.create_repo');
    expect(ids).toContain('github.create_release');
    expect(ids).toContain('github.trigger_workflow');
    expect(ids).toContain('github.get_workflow_status');
    expect(ids).toContain('github.list_issues');
    expect(ids).toContain('github.create_pull_request');

    const triggerTool = tools.find((t) => t.id === 'github.trigger_workflow');
    expect(triggerTool?.risk).toBe('execute');
    expect(triggerTool?.alwaysRequireApproval).toBe(true);

    const releaseTool = tools.find((t) => t.id === 'github.create_release');
    expect(releaseTool?.risk).toBe('write');
    expect(releaseTool?.alwaysRequireApproval).toBe(true);

    expect(tools.find((t) => t.id === 'github.create_pull_request')?.alwaysRequireApproval).toBe(
      true,
    );
  });

  it('validates required arguments for tools', async () => {
    const tools = createAllGitHubTools();
    const getRepoTool = tools.find((t) => t.id === 'github.get_repo')!;

    await expect(
      getRepoTool.run({}, { agentId: 'test', agentName: 'Test' })
    ).rejects.toThrow('owner and repo parameters are required');
  });
});
