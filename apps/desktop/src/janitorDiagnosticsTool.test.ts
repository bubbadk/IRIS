import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJanitorDiagnosticsTool } from './janitorDiagnosticsTool';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

describe('Janitor health checks', () => {
  beforeEach(() => invoke.mockReset());

  it('passes a fixed diagnostic selection through the native boundary', async () => {
    invoke.mockResolvedValue({ target: 'unraid', check: 'full', stdout: 'real output' });
    await createJanitorDiagnosticsTool().run(
      { target: 'unraid', check: 'full' },
      { agentId: 'agent', agentName: 'Janitor' },
    );
    expect(invoke).toHaveBeenCalledWith('run_janitor_diagnostic', {
      target: 'unraid',
      check: 'full',
    });
  });

  it('rejects arbitrary commands and unsupported checks', async () => {
    const tool = createJanitorDiagnosticsTool();
    await expect(
      tool.run({ target: 'local', check: 'uptime' } as never, {
        agentId: 'agent',
        agentName: 'Janitor',
      }),
    ).rejects.toThrow('supported Janitor health check');
  });
});
