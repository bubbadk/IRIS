import { describe, expect, it } from 'vitest';
import type { CortexTurnRecord } from '@iris/cortex';
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatRelativeTime,
  parseHostMetrics,
  summarizeUsage,
} from './systemTelemetry';

function completed(
  turnId: string,
  completedAt: string,
  usage?: { inputTokens: number; outputTokens: number },
): CortexTurnRecord {
  return {
    version: 1,
    turnId,
    agentId: 'agent-1',
    providerId: 'provider-1',
    model: 'model-1',
    status: 'completed',
    startedAt: completedAt,
    updatedAt: completedAt,
    completedAt,
    ...(usage ? { usage } : {}),
  };
}

describe('summarizeUsage', () => {
  it('sums only completed turns that reported usage', () => {
    const running: CortexTurnRecord = {
      version: 1,
      turnId: 'running',
      agentId: 'agent-1',
      providerId: 'provider-1',
      model: 'model-1',
      status: 'running',
      startedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const summary = summarizeUsage([
      completed('a', '2026-08-01T10:00:00.000Z', { inputTokens: 100, outputTokens: 20 }),
      completed('b', '2026-08-01T09:00:00.000Z', { inputTokens: 40, outputTokens: 10 }),
      completed('c', '2026-08-01T08:00:00.000Z'),
      running,
    ]);
    expect(summary.inputTokens).toBe(140);
    expect(summary.outputTokens).toBe(30);
    expect(summary.totalTokens).toBe(170);
    expect(summary.turnsWithUsage).toBe(2);
  });

  it('orders the recent series oldest to newest by completion time', () => {
    const summary = summarizeUsage([
      completed('late', '2026-08-01T12:00:00.000Z', { inputTokens: 3, outputTokens: 0 }),
      completed('early', '2026-08-01T06:00:00.000Z', { inputTokens: 1, outputTokens: 0 }),
      completed('mid', '2026-08-01T09:00:00.000Z', { inputTokens: 2, outputTokens: 0 }),
    ]);
    expect(summary.recentTurnTokens).toEqual([1, 2, 3]);
  });

  it('returns an empty summary when no turn reported usage', () => {
    expect(summarizeUsage([])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      turnsWithUsage: 0,
      recentTurnTokens: [],
    });
  });
});

describe('parseHostMetrics', () => {
  it('keeps reported fields and drops unavailable ones', () => {
    const metrics = parseHostMetrics({
      operatingSystem: 'linux',
      architecture: 'x86_64',
      appVersion: '0.1.0',
      hostname: 'iris-host',
      cpuCount: 16,
      loadAverage: [0.5, 0.4, 0.3],
      memoryTotalBytes: 1000,
      memoryAvailableBytes: 400,
      uptimeSeconds: 3600,
    });
    expect(metrics.hostname).toBe('iris-host');
    expect(metrics.loadAverage).toEqual([0.5, 0.4, 0.3]);
    expect(metrics.memoryAvailableBytes).toBe(400);
  });

  it('rejects a malformed load average without inventing values', () => {
    const metrics = parseHostMetrics({
      operatingSystem: 'linux',
      architecture: 'x86_64',
      appVersion: '0.1.0',
      loadAverage: [0.5, 'nope', 0.3],
    });
    expect(metrics.loadAverage).toBeUndefined();
  });

  it('throws when required identity fields are missing', () => {
    expect(() => parseHostMetrics({ operatingSystem: 'linux' })).toThrow('incomplete metrics');
  });
});

describe('formatting', () => {
  it('formats bytes, counts and durations for compact display', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.0 MB');
    expect(formatCount(950)).toBe('950');
    expect(formatCount(1500)).toBe('1.5k');
    expect(formatCount(2_500_000)).toBe('2.5M');
    expect(formatDuration(90)).toBe('1m');
    expect(formatDuration(3661)).toBe('1h 1m');
    expect(formatDuration(90_000)).toBe('1d 1h');
  });

  it('formats a timestamp as a short time-ago label', () => {
    const now = new Date('2026-08-30T12:00:00.000Z');
    expect(formatRelativeTime('2026-08-30T12:00:00.000Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-08-30T11:59:57.000Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-08-30T11:59:30.000Z', now)).toBe('30s ago');
    expect(formatRelativeTime('2026-08-30T11:55:00.000Z', now)).toBe('5m ago');
    expect(formatRelativeTime('2026-08-30T09:00:00.000Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-08-28T12:00:00.000Z', now)).toBe('2d ago');
    expect(formatRelativeTime('not-a-date', now)).toBe('');
  });
});
