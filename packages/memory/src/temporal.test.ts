import { describe, expect, it } from 'vitest';
import { parseTemporalQuery, temporalBoostFactor } from './temporal';

const NOW = new Date('2026-09-01T12:00:00.000Z');
// For calendar assertions the clock is read in the local timezone, so compute
// the expected boundaries with the same Date APIs the parser uses.
function localDate(y: number, m: number, d: number): number {
  return new Date(y, m, d).getTime();
}

describe('parseTemporalQuery', () => {
  it('returns null for queries without a time expression', () => {
    expect(parseTemporalQuery('Which language does Sarah use?', NOW)).toBeNull();
    expect(parseTemporalQuery('Who is Alex\'s brother?', NOW)).toBeNull();
    expect(parseTemporalQuery('', NOW)).toBeNull();
  });

  it('resolves relative day expressions', () => {
    const yesterday = parseTemporalQuery('What did I do yesterday?', NOW);
    expect(yesterday).not.toBeNull();
    expect(temporalBoostFactor(yesterday, { createdAt: '2026-08-31T10:00:00.000Z' })).toBe(1.6);
    expect(temporalBoostFactor(yesterday, { createdAt: '2026-08-01T10:00:00.000Z' })).toBe(1);

    const today = parseTemporalQuery('What happened today?', NOW);
    expect(temporalBoostFactor(today, { createdAt: '2026-09-01T09:00:00.000Z' })).toBe(1.6);
    expect(temporalBoostFactor(today, { createdAt: '2026-08-30T09:00:00.000Z' })).toBe(1);
  });

  it('resolves last week and last month', () => {
    const lastWeek = parseTemporalQuery('What changed last week?', NOW);
    expect(temporalBoostFactor(lastWeek, { createdAt: '2026-08-28T00:00:00.000Z' })).toBe(1.6);
    expect(temporalBoostFactor(lastWeek, { createdAt: '2026-08-01T00:00:00.000Z' })).toBe(1);

    const lastMonth = parseTemporalQuery('What did we ship last month?', NOW);
    expect(temporalBoostFactor(lastMonth, { createdAt: '2026-08-15T00:00:00.000Z' })).toBe(1.6);
    expect(temporalBoostFactor(lastMonth, { createdAt: '2026-06-15T00:00:00.000Z' })).toBe(1);
  });

  it('resolves month and year windows including with a year', () => {
    const october = parseTemporalQuery('What did Dave purchase in October?', NOW);
    expect(october).not.toBeNull();
    // Asked in September 2026, "October" resolves to the most recent October at
    // or before now — October 2025, not the future October 2026.
    expect(temporalBoostFactor(october, { createdAt: '2025-10-05T00:00:00.000Z' })).toBe(1.6);
    expect(temporalBoostFactor(october, { createdAt: '2026-10-05T00:00:00.000Z' })).toBe(1);
    expect(temporalBoostFactor(october, { createdAt: '2026-09-01T00:00:00.000Z' })).toBe(1);

    const november2026 = parseTemporalQuery('Which model did we pick in November 2026?', NOW);
    expect(temporalBoostFactor(november2026, { createdAt: '2026-11-20T00:00:00.000Z' })).toBe(1.6);

    const year = parseTemporalQuery('What did we decide in 2025?', NOW);
    expect(temporalBoostFactor(year, { createdAt: '2025-07-02T00:00:00.000Z' })).toBe(1.6);
    expect(temporalBoostFactor(year, { createdAt: '2026-07-02T00:00:00.000Z' })).toBe(1);
  });

  it('never boosts records without a parseable timestamp', () => {
    const window = parseTemporalQuery('What happened yesterday?', NOW);
    expect(temporalBoostFactor(window, { createdAt: 'not a date' })).toBe(1);
  });

  it('ignores embedded numbers that only look temporal without a keyword', () => {
    expect(parseTemporalQuery('Run test 40 for me', NOW)).toBeNull();
  });
});

describe('localDate sanity', () => {
  it('keeps the helper honest', () => {
    expect(localDate(2026, 8, 1)).toBe(new Date(2026, 8, 1).getTime());
  });
});

describe('MemoryService duplicate-on-save', () => {
  const makeRepo = () => {
    const records: Array<{ id: string; content: string; createdAt: string; updatedAt: string; provenance: unknown }> = [];
    return {
      records,
      async list() {
        return records.map((r) => ({ ...r }));
      },
      async get(id: string) {
        return records.find((r) => r.id === id) ?? null;
      },
      async save(record: never) {
        const rec = record as { id: string };
        const idx = records.findIndex((r) => r.id === rec.id);
        if (idx >= 0) records[idx] = record;
        else records.unshift(record);
      },
      async remove(id: string) {
        const idx = records.findIndex((r) => r.id === id);
        if (idx >= 0) records.splice(idx, 1);
      },
    };
  };
  it('refreshes the original record instead of storing a duplicate', async () => {
    const { MemoryService } = await import('./index');
    const repo = makeRepo() as never;
    const service = new MemoryService(repo, {
      now: () => new Date('2026-08-27T12:00:00.000Z'),
    });
    const first = await service.remember('The production database is PostgreSQL 18.');
    const second = await service.remember('  The production database is PostgreSQL 18.  ');

    expect(second.id).toBe(first.id);
    const all = await (repo as { list(): Promise<Array<{ id: string; content: string; updatedAt: string }>> }).list();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe('The production database is PostgreSQL 18.');
    expect(all[0].updatedAt).toBe('2026-08-27T12:00:00.000Z');
  });

  it('stores a genuinely different fact as a new record', async () => {
    const { MemoryService } = await import('./index');
    const repo = makeRepo() as never;
    const service = new MemoryService(repo, {
      now: () => new Date('2026-08-27T12:00:00.000Z'),
    });
    await service.remember('The production database is PostgreSQL 18.');
    await service.remember('The team uses MySQL for the legacy billing system.');
    const all = await (repo as { list(): Promise<unknown[]> }).list();
    expect(all).toHaveLength(2);
  });
});
