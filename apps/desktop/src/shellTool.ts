import { invoke } from '@tauri-apps/api/core';
import type { RegisteredTool } from '@iris/tools';
import { workspaceService } from './workspace';

interface SandboxShellResult {
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function inputObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('shell_exec requires an object input.');
  }
  return input as Record<string, unknown>;
}

export function createShellExecTool(): RegisteredTool {
  return {
    id: 'shell.exec',
    name: 'Run command in workspace',
    description:
      'Runs one shell command inside the mounted local workspace directory (bash -lc on Linux/macOS). Returns real exit code, stdout and stderr. Always requires your explicit approval. Not an OS-level jail: the command starts in the workspace but can reference other paths, so review commands before approving them.',
    risk: 'execute',
    alwaysRequireApproval: true,
    providerName: 'shell_exec',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          minLength: 1,
          maxLength: 8000,
          description: 'The shell command to run, e.g. "cargo test" or "python3 script.py".',
        },
        timeoutSeconds: {
          type: 'integer',
          minimum: 1,
          maximum: 300,
          description: 'Optional timeout in seconds (1-300). Defaults to 60.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async run(input) {
      const value = inputObject(input);
      const command = value.command;
      if (typeof command !== 'string' || !command.trim()) {
        throw new Error('shell_exec needs a command to run.');
      }
      if (
        value.timeoutSeconds !== undefined &&
        (!Number.isInteger(value.timeoutSeconds) ||
          (value.timeoutSeconds as number) < 1 ||
          (value.timeoutSeconds as number) > 300)
      ) {
        throw new Error('timeoutSeconds must be an integer from 1 to 300.');
      }
      // Fail honestly before invoking when no workspace is mounted: the command
      // would otherwise have no working directory to run in.
      const mount = await workspaceService.current();
      if (!mount) {
        throw new Error(
          'No local workspace is mounted. Mount a workspace first — shell_exec runs inside it.',
        );
      }
      const result = (await invoke('run_workspace_shell_command', {
        command,
        timeoutSeconds: value.timeoutSeconds,
      })) as SandboxShellResult;
      if (typeof result !== 'object' || result === null) {
        throw new Error('The sandbox shell returned an invalid result.');
      }
      return result;
    },
  };
}
