import { describe, expect, it } from 'vitest';
import {
  proposeKnowledge,
  possibleKnowledgeConflicts,
  reviewKnowledge,
  resolveKnowledge,
  searchKnowledge,
  type KnowledgeInput,
} from './knowledge';
const now = '2026-09-08T10:00:00Z';
const input: KnowledgeInput = {
  id: 'global',
  scope: { kind: 'global' },
  kind: 'preference',
  topic: 'Writing language',
  content: 'English',
  createdAt: now,
  provenance: { source: 'user', actorId: 'user', actorName: 'You', capturedAt: now },
};
describe('search scope precedence before ranking and top-k', () => {
  const active = (id: string, topic: string, content: string, projectId?: string) =>
    reviewKnowledge([proposeKnowledge({
      ...input, id, topic, content,
      scope: projectId ? { kind: 'project', projectId } : { kind: 'global' },
    })], id, 1, 'activate', {}, now)[0];
  const global = active('g', 'Writing language', 'English writing language');
  const project = active('p', ' Writing LANGUAGE ', 'Danish', 'A');
  const ids = (entries: Parameters<typeof searchKnowledge>[0], scope?: string, limit = 100) =>
    searchKnowledge(entries, scope, 'writing language English', now, limit).selected.map(e => e.id);

  it('searches global-only and project-only entries and retains unrelated globals', () => {
    expect(ids([global])).toEqual(['g']);
    expect(ids([project], 'A')).toEqual(['p']);
    const unrelated = active('unrelated', 'Other', 'English', 'A');
    expect(ids([global, unrelated], 'A')).toEqual(['g', 'unrelated']);
  });
  it('excludes higher-scoring global even when the lower-scoring project would miss top-k', () => {
    expect(ids([global, project], 'A')).toEqual(['p']);
    expect(ids([global, project], 'A', 1)).toEqual(['p']);
    expect(searchKnowledge([global, project], 'A', 'English', now).selected).toEqual([]);
  });
  it('preserves global search and isolates projects', () => {
    expect(ids([global, project])).toEqual(['g']);
    expect(ids([global, project], 'B')).toEqual(['g']);
  });
  it('resolves multiple overrides deterministically regardless of input order', () => {
    const secondGlobal = active('g2', 'Secondary language', 'English writing language');
    const secondProject = active('p2', 'Secondary language', 'Danish', 'A');
    const entries = [global, project, secondGlobal, secondProject];
    expect(ids(entries, 'A')).toEqual(['p', 'p2']);
    expect(ids([...entries].reverse(), 'A')).toEqual(['p', 'p2']);
    const tied = [active('b', 'Other B', 'English'), active('a', 'Other A', 'English')];
    expect(ids(tied)).toEqual(['a', 'b']);
    expect(ids([...tied].reverse())).toEqual(['a', 'b']);
  });
  it('does not apply the context limit before search and uses the same conflict validation', () => {
    const fillers = Array.from({ length: 25 }, (_, i) => active(`f${i}`, `Filler ${i}`, 'None'));
    expect(ids([...fillers, global, project], 'A', 1)).toEqual(['p']);
    const conflict = active('conflict', global.topic, 'Other');
    expect(() => ids([global, conflict])).toThrow('Conflicting active knowledge');
  });
});

describe('reviewed durable knowledge', () => {
  it('flags similar active knowledge for human review without treating it as an exact conflict', () => {
    const active = reviewKnowledge([proposeKnowledge(input)], input.id, 1, 'activate', {}, now)[0];
    const proposed = proposeKnowledge({
      ...input,
      id: 'similar',
      topic: 'Preferred writing language',
      content: 'English language preference',
    });
    expect(possibleKnowledgeConflicts([active], proposed).map((entry) => entry.id)).toEqual([
      'global',
    ]);
  });
  it('excludes proposals, archived entries and expired facts from actual context', () => {
    const proposal = proposeKnowledge(input);
    expect(resolveKnowledge([proposal], undefined, now).selected).toEqual([]);
    const active = reviewKnowledge([proposal], proposal.id, 1, 'activate', {}, now);
    expect(resolveKnowledge(active, undefined, now).selected[0].content).toBe('English');
    expect(resolveKnowledge([{ ...active[0], expiresAt: now }], undefined, now).selected).toEqual(
      [],
    );
    expect(
      resolveKnowledge(reviewKnowledge(active, proposal.id, 2, 'archive', {}, now), undefined, now)
        .selected,
    ).toEqual([]);
  });
  it('requires reviewed conflict identities, atomically replaces entries and retains the old content', () => {
    const first = reviewKnowledge([proposeKnowledge(input)], input.id, 1, 'activate', {}, now);
    const second = proposeKnowledge({
      ...input,
      id: 'updated',
      topic: '  Writing LANGUAGE ',
      content: 'Danish',
    });
    expect(() => reviewKnowledge([...first, second], second.id, 1, 'activate', {}, now)).toThrow(
      'Conflicting knowledge',
    );
    const resolved = reviewKnowledge(
      [...first, second],
      second.id,
      1,
      'activate',
      { global: 2 },
      now,
    );
    expect(resolved[0]).toMatchObject({ status: 'archived', content: 'English' });
    expect(resolveKnowledge(resolved, undefined, now).selected[0].content).toBe('Danish');
    expect(() => reviewKnowledge(resolved, second.id, 1, 'archive', {}, now)).toThrow('changed');
  });
  it('isolates project knowledge and gives it precedence over the same global topic', () => {
    const global = reviewKnowledge([proposeKnowledge(input)], input.id, 1, 'activate', {}, now)[0];
    const project = reviewKnowledge(
      [
        proposeKnowledge({
          ...input,
          id: 'project',
          scope: { kind: 'project', projectId: 'p' },
          content: 'Danish',
        }),
      ],
      'project',
      1,
      'activate',
      {},
      now,
    )[0];
    expect(resolveKnowledge([global, project], 'p', now).selected.map((entry) => entry.id)).toEqual(
      ['project'],
    );
    expect(
      resolveKnowledge([global, project], 'other', now).selected.map((entry) => entry.id),
    ).toEqual(['global']);
    expect(
      resolveKnowledge([global, project], undefined, now).selected.map((entry) => entry.id),
    ).toEqual(['global']);
  });
  it('retains the agent turn and tool provenance but refuses oversized content and stale expiry', () => {
    const proposal = proposeKnowledge({
      ...input,
      expiresAt: now,
      provenance: {
        source: 'agent',
        actorId: 'agent',
        actorName: 'Writer',
        turnId: 'turn',
        toolCallId: 'call',
        capturedAt: now,
      },
    });
    expect(proposal.provenance).toMatchObject({ turnId: 'turn', toolCallId: 'call' });
    expect(() => reviewKnowledge([proposal], proposal.id, 1, 'activate', {}, now)).toThrow(
      'expired',
    );
    expect(() => proposeKnowledge({ ...input, content: 'ø'.repeat(2049) })).toThrow('4 KiB');
  });
  it('reports context omissions instead of silently claiming unlimited recall', () => {
    const entries = Array.from(
      { length: 22 },
      (_, i) =>
        reviewKnowledge(
          [proposeKnowledge({ ...input, id: String(i), topic: String(i) })],
          String(i),
          1,
          'activate',
          {},
          now,
        )[0],
    );
    const result = resolveKnowledge(entries, undefined, now);
    expect(result.selected).toHaveLength(20);
    expect(result.omitted).toBe(2);
  });
  it('searches relevant approved knowledge beyond the 20-entry turn context limit', () => {
    const entries = Array.from(
      { length: 24 },
      (_, index) =>
        reviewKnowledge(
          [
            proposeKnowledge({
              ...input,
              id: String(index),
              topic: index === 23 ? 'Emergency printer instructions' : `General note ${index}`,
              content: index === 23 ? 'Use tray two for labels.' : 'Ordinary reference.',
            }),
          ],
          String(index),
          1,
          'activate',
          {},
          now,
        )[0],
    );
    expect(resolveKnowledge(entries, undefined, now).selected).toHaveLength(20);
    expect(
      searchKnowledge(entries, undefined, 'printer labels', now).selected.map((entry) => entry.id),
    ).toEqual(['23']);
  });
});
