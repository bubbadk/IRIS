import { invoke } from '@tauri-apps/api/core';
import type { CortexTurnRecord } from '@iris/cortex';
import { isTauriRuntime } from './credentials';

export interface HostMetrics {
  operatingSystem: string;
  architecture: string;
  appVersion: string;
  hostname?: string;
  cpuCount?: number;
  loadAverage?: [number, number, number];
  memoryTotalBytes?: number;
  memoryAvailableBytes?: number;
  uptimeSeconds?: number;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Completed turns that carried a usage report. */
  turnsWithUsage: number;
  /** Total token count per recent completed turn, oldest to newest. */
  recentTurnTokens: number[];
}

interface HostMetricsDependencies {
  available: () => boolean;
  invokeNative: (command: string) => Promise<unknown>;
}

const defaultDependencies: HostMetricsDependencies = {
  available: isTauriRuntime,
  invokeNative: (command) => invoke(command),
};

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function loadAverage(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const numbers = value.map(optionalNumber);
  if (numbers.some((entry) => entry === undefined)) return undefined;
  return numbers as [number, number, number];
}

/** Parses the native host metrics payload, keeping only fields the kernel actually reported. */
export function parseHostMetrics(value: unknown): HostMetrics {
  if (!value || typeof value !== 'object') {
    throw new Error('The host returned invalid metrics.');
  }
  const candidate = value as Record<string, unknown>;
  const operatingSystem = optionalString(candidate.operatingSystem);
  const architecture = optionalString(candidate.architecture);
  const appVersion = optionalString(candidate.appVersion);
  if (!operatingSystem || !architecture || !appVersion) {
    throw new Error('The host returned incomplete metrics.');
  }
  return {
    operatingSystem,
    architecture,
    appVersion,
    hostname: optionalString(candidate.hostname),
    cpuCount: optionalNumber(candidate.cpuCount),
    loadAverage: loadAverage(candidate.loadAverage),
    memoryTotalBytes: optionalNumber(candidate.memoryTotalBytes),
    memoryAvailableBytes: optionalNumber(candidate.memoryAvailableBytes),
    uptimeSeconds: optionalNumber(candidate.uptimeSeconds),
  };
}

/** Reads live host telemetry, or null when running outside the native desktop shell. */
export async function readHostMetrics(
  dependencies: HostMetricsDependencies = defaultDependencies,
): Promise<HostMetrics | null> {
  if (!dependencies.available()) return null;
  return parseHostMetrics(await dependencies.invokeNative('inspect_host_metrics'));
}

function turnTimestamp(record: CortexTurnRecord): string {
  return record.status === 'completed' ? record.completedAt : record.updatedAt;
}

/** Aggregates real token usage from completed Cortex turns. Never invents counts. */
export function summarizeUsage(records: CortexTurnRecord[], recentLimit = 24): UsageSummary {
  const withUsage = records
    .filter(
      (record): record is CortexTurnRecord & { usage: { inputTokens: number; outputTokens: number } } =>
        record.status === 'completed' &&
        !!record.usage &&
        Number.isFinite(record.usage.inputTokens) &&
        Number.isFinite(record.usage.outputTokens),
    )
    .sort((left, right) => turnTimestamp(left).localeCompare(turnTimestamp(right)));

  let inputTokens = 0;
  let outputTokens = 0;
  for (const record of withUsage) {
    inputTokens += record.usage.inputTokens;
    outputTokens += record.usage.outputTokens;
  }

  const recentTurnTokens = withUsage
    .slice(-recentLimit)
    .map((record) => record.usage.inputTokens + record.usage.outputTokens);

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    turnsWithUsage: withUsage.length,
    recentTurnTokens,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}

export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.max(0, Math.floor(seconds))}s`;
}

/** Formats an ISO timestamp as a short "time ago" label for a live activity feed. */
export function formatRelativeTime(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
