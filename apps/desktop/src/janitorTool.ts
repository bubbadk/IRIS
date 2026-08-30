import { invoke } from '@tauri-apps/api/core';
import type { RegisteredTool } from '@iris/tools';
import { requestSudoPassword } from './sudoPasswordPrompt';

type JanitorTarget = 'local' | 'unraid';

interface JanitorCommandInput {
  target: JanitorTarget;
  command: string;
}

// Only used to decide whether to show the password popup up front; the backend re-checks
// this itself (and is the one that actually decides whether the command runs).
const NEEDS_SUDO = /\bsudo\b/i;

export function createJanitorCommandTool(): RegisteredTool {
  return {
    id: 'janitor.command',
    name: 'Run Janitor command',
    description:
      'Runs a user-requested diagnostic or maintenance command on the local PC or Unraid.',
    risk: 'execute',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['local', 'unraid'] },
        command: { type: 'string', minLength: 1, maxLength: 4000 },
      },
      required: ['target', 'command'],
      additionalProperties: false,
    },
    async run(input) {
      if (!input || typeof input !== 'object')
        throw new Error('Janitor command input must be an object.');
      const value = input as Partial<JanitorCommandInput>;
      if (value.target !== 'local' && value.target !== 'unraid')
        throw new Error('Choose local or unraid as the command target.');
      if (typeof value.command !== 'string' || !value.command.trim())
        throw new Error('Janitor needs a command.');
      if (value.command.length > 4000)
        throw new Error('Janitor commands are limited to 4000 characters.');

      if (value.target === 'local' && NEEDS_SUDO.test(value.command)) {
        const password = await requestSudoPassword(value.command);
        if (password === null) {
          throw new Error('The user did not enter a sudo password, so the command was not run.');
        }
        return invoke('run_janitor_command', {
          target: value.target,
          command: value.command,
          sudoPassword: password,
        });
      }

      try {
        return await invoke('run_janitor_command', {
          target: value.target,
          command: value.command,
        });
      } catch (error) {
        // The backend has its own final say on whether sudo is needed (it parses the
        // real command, not just this schema's copy) — handle that case too.
        if (error === 'SUDO_PASSWORD_REQUIRED' || (error instanceof Error && error.message === 'SUDO_PASSWORD_REQUIRED')) {
          const password = await requestSudoPassword(value.command);
          if (password === null) {
            throw new Error('The user did not enter a sudo password, so the command was not run.');
          }
          return invoke('run_janitor_command', {
            target: value.target,
            command: value.command,
            sudoPassword: password,
          });
        }
        throw error;
      }
    },
  };
}
