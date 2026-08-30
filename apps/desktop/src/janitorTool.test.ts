import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJanitorCommandTool } from './janitorTool';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const { requestSudoPassword } = vi.hoisted(() => ({ requestSudoPassword: vi.fn() }));
vi.mock('./sudoPasswordPrompt', () => ({ requestSudoPassword }));

const context = { agentId: 'agent', agentName: 'Janitor' };

describe('Janitor command tool', () => {
  beforeEach(() => {
    invoke.mockReset();
    requestSudoPassword.mockReset();
  });

  it('runs a plain local command without asking for a password', async () => {
    invoke.mockResolvedValue({ target: 'local', exitCode: 0, stdout: 'ok', stderr: '' });
    await createJanitorCommandTool().run({ target: 'local', command: 'df -h' }, context);
    expect(requestSudoPassword).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('run_janitor_command', {
      target: 'local',
      command: 'df -h',
    });
  });

  it('asks for a sudo password up front for a local command that needs one', async () => {
    requestSudoPassword.mockResolvedValue('hunter2');
    invoke.mockResolvedValue({ target: 'local', exitCode: 0, stdout: 'ok', stderr: '' });
    await createJanitorCommandTool().run(
      { target: 'local', command: 'sudo systemctl restart docker' },
      context,
    );
    expect(requestSudoPassword).toHaveBeenCalledWith('sudo systemctl restart docker');
    expect(invoke).toHaveBeenCalledWith('run_janitor_command', {
      target: 'local',
      command: 'sudo systemctl restart docker',
      sudoPassword: 'hunter2',
    });
  });

  it('fails without running anything when the user cancels the password prompt', async () => {
    requestSudoPassword.mockResolvedValue(null);
    const tool = createJanitorCommandTool();
    await expect(
      tool.run({ target: 'local', command: 'sudo reboot' }, context),
    ).rejects.toThrow('did not enter a sudo password');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not prompt for unraid, which already connects as root', async () => {
    invoke.mockResolvedValue({ target: 'unraid', exitCode: 0, stdout: 'ok', stderr: '' });
    await createJanitorCommandTool().run(
      { target: 'unraid', command: 'sudo -v' },
      context,
    );
    expect(requestSudoPassword).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('run_janitor_command', {
      target: 'unraid',
      command: 'sudo -v',
    });
  });

  it('falls back to the password prompt if the backend decides a command needs sudo even when our own check missed it', async () => {
    // Defense in depth: the backend re-parses the real command, so it should still get a
    // password prompt even if this file's own sudo detection didn't fire first.
    invoke.mockRejectedValueOnce('SUDO_PASSWORD_REQUIRED');
    invoke.mockResolvedValueOnce({ target: 'local', exitCode: 0, stdout: 'ok', stderr: '' });
    requestSudoPassword.mockResolvedValue('hunter2');
    await createJanitorCommandTool().run({ target: 'local', command: 'echo hi' }, context);
    expect(requestSudoPassword).toHaveBeenCalledWith('echo hi');
    expect(invoke).toHaveBeenNthCalledWith(2, 'run_janitor_command', {
      target: 'local',
      command: 'echo hi',
      sudoPassword: 'hunter2',
    });
  });
});
