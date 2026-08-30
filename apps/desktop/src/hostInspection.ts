import { invoke } from '@tauri-apps/api/core';
import type { RegisteredTool } from '@iris/tools';
import { isTauriRuntime } from './credentials';

export interface HostSnapshot {
  operatingSystem: string;
  architecture: string;
  appVersion: string;
}

interface HostInspectionDependencies {
  available: () => boolean;
  invokeNative: (command: string) => Promise<unknown>;
}

const defaultDependencies: HostInspectionDependencies = {
  available: isTauriRuntime,
  invokeNative: (command) => invoke(command),
};

function hostSnapshot(value: unknown): HostSnapshot {
  if (!value || typeof value !== 'object')
    throw new Error('The host returned an invalid snapshot.');
  const candidate = value as Record<string, unknown>;
  const fields = ['operatingSystem', 'architecture', 'appVersion'] as const;
  if (fields.some((field) => typeof candidate[field] !== 'string' || !candidate[field])) {
    throw new Error('The host returned an incomplete snapshot.');
  }
  return {
    operatingSystem: candidate.operatingSystem as string,
    architecture: candidate.architecture as string,
    appVersion: candidate.appVersion as string,
  };
}

export function createHostInspectionTool(
  dependencies: HostInspectionDependencies = defaultDependencies,
): RegisteredTool {
  return {
    id: 'system.inspect-host',
    name: 'Inspect IRIS host',
    description: 'Reads the local operating system, architecture and installed IRIS version.',
    risk: 'read',
    providerName: 'system_inspect_host',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(input) {
      if (
        input !== undefined &&
        input !== null &&
        (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 0)
      ) {
        throw new Error('Inspect IRIS host does not accept input.');
      }
      if (!dependencies.available()) {
        throw new Error('Host inspection is available only in the native IRIS desktop app.');
      }
      return hostSnapshot(await dependencies.invokeNative('inspect_host'));
    },
  };
}
