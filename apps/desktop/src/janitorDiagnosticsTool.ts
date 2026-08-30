import { invoke } from '@tauri-apps/api/core';
import type { RegisteredTool } from '@iris/tools';

type DiagnosticCheck =
  'connectivity' | 'system' | 'storage' | 'containers' | 'crash-loops' | 'full';

interface DiagnosticInput {
  target: 'local' | 'unraid';
  check: DiagnosticCheck;
}

export function createJanitorDiagnosticsTool(): RegisteredTool {
  return {
    id: 'janitor.health',
    name: 'Run Janitor health check',
    description:
      'Runs a fixed, read-only health check for the local PC or Unraid: connectivity, system, storage, Docker containers and crash loops. The full check runs all diagnostics and returns real command output.',
    risk: 'execute',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['local', 'unraid'] },
        check: {
          type: 'string',
          enum: ['connectivity', 'system', 'storage', 'containers', 'crash-loops', 'full'],
        },
      },
      required: ['target', 'check'],
      additionalProperties: false,
    },
    async run(input) {
      if (!input || typeof input !== 'object')
        throw new Error('Health check input must be an object.');
      const value = input as Partial<DiagnosticInput>;
      if (value.target !== 'local' && value.target !== 'unraid') {
        throw new Error('Choose local or unraid as the health check target.');
      }
      const checks: DiagnosticCheck[] = [
        'connectivity',
        'system',
        'storage',
        'containers',
        'crash-loops',
        'full',
      ];
      if (!value.check || !checks.includes(value.check)) {
        throw new Error('Choose a supported Janitor health check.');
      }
      return invoke('run_janitor_diagnostic', { target: value.target, check: value.check });
    },
  };
}
