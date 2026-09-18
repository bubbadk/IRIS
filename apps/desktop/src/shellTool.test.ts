import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShellExecTool } from './shellTool';
const { invoke, current } = vi.hoisted(() => ({ invoke: vi.fn(), current: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('./workspace', () => ({ workspaceService: { current } }));
afterEach(() => vi.resetAllMocks());
const context = { agentId: 'test', agentName: 'Test' };
const result = {
  cwd: '/workspace',
  stdout: 'real output',
  stderr: '',
  exitCode: 0,
  timedOut: false,
};

describe('workspace shell permission policy', () => {
  it('always requires approval so publication commands cannot bypass GitHub safeguards', () => {
    expect(createShellExecTool().alwaysRequireApproval).toBe(true);
  });
  it('defaults to isolated execution and verifies capability before dispatch', async () => {
    current.mockResolvedValue({ id: 'workspace' });
    invoke
      .mockResolvedValueOnce({ available: true })
      .mockResolvedValueOnce({ ...result, isolation: 'workspace' });
    await createShellExecTool().run({ command: 'test command' }, context);
    expect(invoke).toHaveBeenNthCalledWith(1, 'workspace_shell_isolation_status');
    expect(invoke).toHaveBeenNthCalledWith(2, 'run_workspace_shell_command', {
      command: 'test command',
      isolation: 'workspace',
      timeoutSeconds: undefined,
    });
  });
  it('never falls back to host execution when isolation is unavailable', async () => {
    current.mockResolvedValue({ id: 'workspace' });
    invoke.mockResolvedValue({ available: false, detail: 'User namespaces disabled.' });
    await expect(createShellExecTool().run({ command: 'test command' }, context)).rejects.toThrow(
      'not run on the host',
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('dispatches explicit host mode and rejects unsupported modes before invocation', async () => {
    current.mockResolvedValue({ id: 'workspace' });
    invoke.mockResolvedValue({ ...result, isolation: 'host' });
    await createShellExecTool().run({ command: 'test command', isolation: 'host' }, context);
    expect(invoke).toHaveBeenCalledWith(
      'run_workspace_shell_command',
      expect.objectContaining({ isolation: 'host' }),
    );
    invoke.mockClear();
    await expect(
      createShellExecTool().run({ command: 'test command', isolation: 'automatic' }, context),
    ).rejects.toThrow('workspace or host');
    expect(invoke).not.toHaveBeenCalled();
  });
});
