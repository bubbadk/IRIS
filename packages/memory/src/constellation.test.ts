import { describe, expect, it } from 'vitest';
import { buildConstellation, filterTracesByTime } from './constellation';
import type { MemoryRecord } from './index';

const record = (id: string, content: string, createdAt: string): MemoryRecord => ({
  id,
  content,
  createdAt,
  updatedAt: createdAt,
  provenance: {
    source: 'user',
    actorId: 'u',
    actorName: 'Alex',
    capturedAt: createdAt,
  },
});

const pack = (turnId: string, prompt: string, createdAt: string, ids: string[]) => ({
  turnId,
  prompt,
  createdAt,
  selections: ids.map((sourceId) => ({ source: 'memory', sourceId })),
});

const RECORDS = [
  record('db', 'The production database is PostgreSQL 18.', '2026-08-20T10:00:00.000Z'),
  record('backup', 'Backups run nightly at 02:00.', '2026-08-21T10:00:00.000Z'),
  record('kayak', 'Kayaking photos live on the NAS.', '2026-08-25T10:00:00.000Z'),
];

describe('buildConstellation', () => {
  it('creates a node for every record and counts retrievals', () => {
    const packs = [
      pack('t1', 'What database do we run?', '2026-08-26T10:00:00.000Z', ['db', 'backup']),
      pack('t2', 'Database and backups again', '2026-08-27T10:00:00.000Z', ['db']),
    ];
    const constellation = buildConstellation(RECORDS, packs);

    expect(constellation.nodes).toHaveLength(3);
    const db = constellation.nodes.find((node) => node.memoryId === 'db');
    const kayak = constellation.nodes.find((node) => node.memoryId === 'kayak');
    expect(db?.usageCount).toBe(2);
    expect(db?.lastUsedAt).toBe('2026-08-27T10:00:00.000Z');
    expect(kayak?.usageCount).toBe(0);
    expect(kayak?.lastUsedAt).toBeNull();
  });

  it('links memories retrieved together and sums co-retrieval weight', () => {
    const packs = [
      pack('t1', 'db with backup', '2026-08-26T10:00:00.000Z', ['db', 'backup']),
      pack('t2', 'db with backup again', '2026-08-27T10:00:00.000Z', ['backup', 'db']),
    ];
    const constellation = buildConstellation(RECORDS, packs);

    expect(constellation.links).toHaveLength(1);
    expect(constellation.links[0]).toMatchObject({
      fromId: 'backup',
      toId: 'db',
      weight: 2,
    });
  });

  it('preserves retrieval rank order in traces', () => {
    const packs = [pack('t1', 'q', '2026-08-26T10:00:00.000Z', ['backup', 'db'])];
    const constellation = buildConstellation(RECORDS, packs);
    expect(constellation.traces[0]?.rankedIds).toEqual(['backup', 'db']);
  });

  it('ignores selections referencing deleted memories', () => {
    const packs = [pack('t1', 'q', '2026-08-26T10:00:00.000Z', ['db', 'ghost'])];
    const constellation = buildConstellation(RECORDS, packs);
    expect(constellation.traces[0]?.rankedIds).toEqual(['db']);
    expect(constellation.nodes.find((node) => node.memoryId === 'db')?.usageCount).toBe(1);
    expect(constellation.links).toHaveLength(0);
  });

  it('returns dormant stars when no packs exist', () => {
    const constellation = buildConstellation(RECORDS, []);
    expect(constellation.nodes).toHaveLength(3);
    expect(constellation.links).toHaveLength(0);
    expect(constellation.traces).toHaveLength(0);
  });

  it('lists traces in chronological order regardless of pack order', () => {
    const packs = [
      pack('late', 'later', '2026-08-28T10:00:00.000Z', ['db']),
      pack('early', 'earlier', '2026-08-26T10:00:00.000Z', ['db']),
    ];
    const constellation = buildConstellation(RECORDS, packs);
    expect(constellation.traces.map((trace) => trace.turnId)).toEqual(['early', 'late']);
  });
});

describe('filterTracesByTime', () => {
  it('keeps only traces inside the inclusive window', () => {
    const packs = [
      pack('a', 'a', '2026-08-25T10:00:00.000Z', ['db']),
      pack('b', 'b', '2026-08-26T10:00:00.000Z', ['db']),
      pack('c', 'c', '2026-08-30T10:00:00.000Z', ['db']),
    ];
    const traces = buildConstellation(RECORDS, packs).traces;
    const filtered = filterTracesByTime(
      traces,
      Date.parse('2026-08-26T00:00:00.000Z'),
      Date.parse('2026-08-29T00:00:00.000Z'),
    );
    expect(filtered.map((trace) => trace.turnId)).toEqual(['b']);
  });
});
