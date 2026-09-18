import { invoke } from '@tauri-apps/api/core';
import type { RegisteredTool } from '@iris/tools';
import { workspaceService } from './workspace';

interface SandboxShellResult {
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  isolation: 'workspace' | 'host';
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
      'Runs a shell command with explicit approval. Defaults to Linux workspace isolation: offline, workspace mounted at /workspace, read-only system tools, temporary home, no inherited credentials. Requires Bubblewrap and user namespaces; unavailable isolation fails without host fallback. Setting isolation to host explicitly requests unrestricted host execution, which still requires approval. Files and secrets inside the mounted workspace are accessible in both modes. Shell changes have no automatic restore point.',
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
        isolation: {
          type: 'string',
          enum: ['workspace', 'host'],
          default: 'workspace',
          description:
            'workspace: offline Linux sandbox (default). host: explicit unrestricted host execution; requires approval.',
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
      const isolation = value.isolation ?? 'workspace';
      if (isolation !== 'workspace' && isolation !== 'host')
        throw new Error('isolation must be workspace or host.');
      if (
        Object.keys(value).some((key) => !['command', 'timeoutSeconds', 'isolation'].includes(key))
      )
        throw new Error('shell_exec received an unsupported input field.');
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
      if (isolation === 'workspace') {
        const status: unknown = await invoke('workspace_shell_isolation_status');
        if (
          !status ||
          typeof status !== 'object' ||
          !('available' in status) ||
          status.available !== true
        ) {
          const detail =
            status &&
            typeof status === 'object' &&
            'detail' in status &&
            typeof status.detail === 'string'
              ? status.detail
              : 'Workspace isolation is unavailable.';
          throw new Error(`${detail} The command was not run on the host.`);
        }
      }
      const result = (await invoke('run_workspace_shell_command', {
        command,
        isolation,
        timeoutSeconds: value.timeoutSeconds,
      })) as SandboxShellResult;
      if (
        typeof result !== 'object' ||
        result === null ||
        result.isolation !== isolation ||
        typeof result.stdout !== 'string' ||
        typeof result.stderr !== 'string' ||
        typeof result.timedOut !== 'boolean' ||
        !(result.exitCode === null || Number.isInteger(result.exitCode))
      ) {
        throw new Error('The sandbox shell returned an invalid result.');
      }
      return result;
    },
  };
}
