import type { MemoryProvenance } from './index';
export type KnowledgeScope = { kind: 'global' } | { kind: 'project'; projectId: string };
export interface KnowledgeEntry {
  version: 1;
  id: string;
  revision: number;
  scope: KnowledgeScope;
  kind: 'fact' | 'preference';
  topic: string;
  content: string;
  sourceReference?: string;
  expiresAt?: string;
  replacesId?: string;
  createdAt: string;
  provenance: MemoryProvenance;
  status: 'proposed' | 'active' | 'archived';
  reviewedAt?: string;
}
export type KnowledgeInput = Omit<KnowledgeEntry, 'version' | 'revision' | 'status' | 'reviewedAt'>;
export const knowledgeContextLimit = 20;
export function sameKnowledgeScope(a: KnowledgeScope, b: KnowledgeScope): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === 'global' || (b.kind === 'project' && a.projectId === b.projectId))
  );
}
export function knowledgeKey(entry: Pick<KnowledgeEntry, 'kind' | 'topic'>): string {
  return `${entry.kind}:${entry.topic.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}
export function validateKnowledgeEntry(value: unknown): value is KnowledgeEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<KnowledgeEntry>;
  const validDate = (date: unknown) =>
    typeof date === 'string' && Number.isFinite(Date.parse(date));
  if (
    e.version !== 1 ||
    typeof e.id !== 'string' ||
    !e.id ||
    !Number.isInteger(e.revision) ||
    e.revision! < 1 ||
    !e.scope ||
    !['global', 'project'].includes(e.scope.kind) ||
    (e.scope.kind === 'project' && (typeof e.scope.projectId !== 'string' || !e.scope.projectId)) ||
    !['fact', 'preference'].includes(e.kind ?? '') ||
    typeof e.topic !== 'string' ||
    !e.topic.trim() ||
    e.topic.length > 120 ||
    typeof e.content !== 'string' ||
    !e.content.trim() ||
    new TextEncoder().encode(e.content).byteLength > 4096 ||
    !validDate(e.createdAt) ||
    (e.expiresAt !== undefined && !validDate(e.expiresAt)) ||
    (e.sourceReference !== undefined &&
      (typeof e.sourceReference !== 'string' || e.sourceReference.length > 1000)) ||
    (e.replacesId !== undefined && typeof e.replacesId !== 'string') ||
    !['proposed', 'active', 'archived'].includes(e.status ?? '') ||
    (e.reviewedAt !== undefined && !validDate(e.reviewedAt)) ||
    (e.status === 'active' && !e.reviewedAt)
  )
    return false;
  const p = e.provenance;
  return Boolean(
    p &&
    ['user', 'agent'].includes(p.source) &&
    typeof p.actorId === 'string' &&
    p.actorId &&
    typeof p.actorName === 'string' &&
    p.actorName &&
    validDate(p.capturedAt) &&
    (p.source === 'user' ||
      (typeof p.turnId === 'string' &&
        p.turnId &&
        typeof p.toolCallId === 'string' &&
        p.toolCallId)),
  );
}
export function proposeKnowledge(input: KnowledgeInput): KnowledgeEntry {
  const entry: KnowledgeEntry = {
    ...input,
    topic: input.topic.trim(),
    content: input.content.trim(),
    version: 1,
    revision: 1,
    status: 'proposed',
  };
  if (!validateKnowledgeEntry(entry))
    throw new Error('Knowledge requires a topic, valid provenance and up to 4 KiB of content.');
  return structuredClone(entry);
}
export function knowledgeExpired(entry: KnowledgeEntry, now: string): boolean {
  return Boolean(entry.expiresAt && Date.parse(entry.expiresAt) <= Date.parse(now));
}
export function knowledgeConflicts(
  entries: readonly KnowledgeEntry[],
  proposed: KnowledgeEntry,
): KnowledgeEntry[] {
  return entries.filter(
    (entry) =>
      entry.id !== proposed.id &&
      entry.status === 'active' &&
      sameKnowledgeScope(entry.scope, proposed.scope) &&
      (knowledgeKey(entry) === knowledgeKey(proposed) || entry.id === proposed.replacesId),
  );
}

/** Conservative lexical similarity signal for human review; it never replaces or archives entries. */
export function possibleKnowledgeConflicts(
  entries: readonly KnowledgeEntry[],
  proposed: KnowledgeEntry,
): KnowledgeEntry[] {
  const tokens = (value: string) => new Set(value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const target = tokens(`${proposed.topic} ${proposed.content}`);
  if (target.size < 2) return [];
  return entries.filter((entry) => {
    if (
      entry.id === proposed.id ||
      entry.status !== 'active' ||
      entry.kind !== proposed.kind ||
      !sameKnowledgeScope(entry.scope, proposed.scope) ||
      knowledgeConflicts(entries, proposed).some((conflict) => conflict.id === entry.id)
    )
      return false;
    const candidate = tokens(`${entry.topic} ${entry.content}`);
    const shared = [...target].filter((token) => candidate.has(token)).length;
    return shared / Math.max(target.size, candidate.size) >= 0.6;
  });
}
export function reviewKnowledge(
  entries: readonly KnowledgeEntry[],
  id: string,
  expectedRevision: number,
  decision: 'activate' | 'archive',
  reviewedConflicts: Readonly<Record<string, number>>,
  now: string,
): KnowledgeEntry[] {
  const entry = entries.find((item) => item.id === id);
  if (!entry || entry.revision !== expectedRevision)
    throw new Error('This knowledge entry changed. Refresh before reviewing it.');
  if (decision === 'activate' && entry.status !== 'proposed')
    throw new Error('Only proposed entries can be activated.');
  if (decision === 'activate' && knowledgeExpired(entry, now))
    throw new Error('This entry has expired. Create a revision with a current expiry date.');
  const conflicts = decision === 'activate' ? knowledgeConflicts(entries, entry) : [];
  if (
    conflicts.length !== Object.keys(reviewedConflicts).length ||
    conflicts.some((item) => reviewedConflicts[item.id] !== item.revision)
  )
    throw new Error(
      'Conflicting knowledge changed. Review the current conflicting entries before replacing them.',
    );
  return entries.map((item) =>
    item.id === id
      ? {
          ...structuredClone(item),
          status: decision === 'activate' ? 'active' : 'archived',
          revision: item.revision + 1,
          reviewedAt: now,
        }
      : conflicts.some((conflict) => conflict.id === item.id)
        ? {
            ...structuredClone(item),
            status: 'archived',
            revision: item.revision + 1,
            reviewedAt: now,
          }
        : structuredClone(item),
  );
}
/** Resolve scope precedence over the complete candidate set, before any ranking or limit. */
function effectiveKnowledge(
  entries: readonly KnowledgeEntry[],
  projectId: string | undefined,
  now: string,
): KnowledgeEntry[] {
  const selected = new Map<string, KnowledgeEntry>();
  const candidates = entries.filter(
    (entry) =>
      entry.status === 'active' &&
      !knowledgeExpired(entry, now) &&
      (entry.scope.kind === 'global' || entry.scope.projectId === projectId),
  );
  for (const entry of candidates.sort(
    (a, b) => Number(a.scope.kind === 'project') - Number(b.scope.kind === 'project'),
  )) {
    const key = knowledgeKey(entry),
      previous = selected.get(key);
    if (previous && sameKnowledgeScope(previous.scope, entry.scope))
      throw new Error('Conflicting active knowledge must be reviewed before it can be used.');
    selected.set(key, entry);
  }
  return [...selected.values()];
}

export function resolveKnowledge(
  entries: readonly KnowledgeEntry[],
  projectId: string | undefined,
  now: string,
): { selected: KnowledgeEntry[]; omitted: number } {
  const ordered = effectiveKnowledge(entries, projectId, now).sort(
    (a, b) =>
      Number(b.kind === 'preference') - Number(a.kind === 'preference') ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.id.localeCompare(b.id),
  );
  return {
    selected: structuredClone(ordered.slice(0, knowledgeContextLimit)),
    omitted: Math.max(0, ordered.length - knowledgeContextLimit),
  };
}

/** Searches all current approved entries instead of silently stopping at the turn-context limit. */
export function searchKnowledge(
  entries: readonly KnowledgeEntry[],
  projectId: string | undefined,
  query: string,
  now: string,
  limit = 100,
): { selected: KnowledgeEntry[]; omitted: number } {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])];
  if (!terms.length) throw new Error('Knowledge search needs at least one letter or number.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Knowledge search limit must be between 1 and 100.');
  const ranked = effectiveKnowledge(entries, projectId, now)
    .map((entry) => {
      const topic = entry.topic.toLowerCase();
      const content = entry.content.toLowerCase();
      const score = terms.reduce(
        (total, term) => total + (topic.includes(term) ? 3 : 0) + (content.includes(term) ? 1 : 0),
        0,
      );
      return { entry, score };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.entry.scope.kind === 'project') - Number(a.entry.scope.kind === 'project') ||
        b.entry.createdAt.localeCompare(a.entry.createdAt) ||
        a.entry.id.localeCompare(b.entry.id),
    );
  return {
    selected: structuredClone(ranked.slice(0, limit).map(({ entry }) => entry)),
    omitted: Math.max(0, ranked.length - limit),
  };
}
export function renderKnowledge(entry: KnowledgeEntry): string {
  return `[${entry.kind}; ${entry.scope.kind}; id ${entry.id}; revision ${entry.revision}; approved ${entry.reviewedAt}] ${entry.topic}\n${entry.content}\nSource: ${entry.provenance.actorName}, ${entry.provenance.capturedAt}${entry.sourceReference ? `; ${entry.sourceReference}` : ''}${entry.expiresAt ? `\nExpires: ${entry.expiresAt}` : ''}`;
}
