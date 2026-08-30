import type { AgentDefinition } from '@iris/core';

interface MemoryProvenanceBase {
  actorId: string;
  actorName: string;
  capturedAt: string;
}

export interface UserMemoryProvenance extends MemoryProvenanceBase {
  source: 'user';
}

export interface AgentMemoryProvenance extends MemoryProvenanceBase {
  source: 'agent';
  turnId: string;
  toolCallId: string;
}

export type MemoryProvenance = UserMemoryProvenance | AgentMemoryProvenance;

export interface MemoryRecord {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  provenance: MemoryProvenance;
}

export interface MemoryRepository {
  list(): Promise<MemoryRecord[]>;
  get(id: string): Promise<MemoryRecord | null>;
  save(record: MemoryRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface MemoryRetrievalRequest {
  query: string;
  limit: number;
}

export interface MemoryRetriever {
  retrieve(
    records: readonly MemoryRecord[],
    request: MemoryRetrievalRequest,
  ): Promise<MemoryRecord[]>;
}

export interface MemoryEmbedder {
  embed(input: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface MemoryEmbeddingScope {
  providerId: string;
  model: string;
}

export interface MemoryEmbeddingIndexEntry {
  memoryId: string;
  sourceFingerprint: string;
  vector: number[];
}

export interface MemoryEmbeddingIndexFailure {
  memoryId: string;
  sourceFingerprint: string;
  attempts: number;
  error: string;
  lastAttemptAt: string;
}

export interface MemoryEmbeddingIndex {
  scope: MemoryEmbeddingScope;
  builtAt: string | null;
  updatedAt: string;
  entries: MemoryEmbeddingIndexEntry[];
  failures: MemoryEmbeddingIndexFailure[];
}

export interface MemoryEmbeddingIndexRepository {
  get(scope: MemoryEmbeddingScope): Promise<MemoryEmbeddingIndex | null>;
  save(index: MemoryEmbeddingIndex): Promise<void>;
  clear(): Promise<void>;
}

export type MemoryEmbeddingRecordStatus =
  | { memoryId: string; state: 'ready' }
  | { memoryId: string; state: 'pending' }
  | {
      memoryId: string;
      state: 'failed';
      attempts: number;
      error: string;
      lastAttemptAt: string;
    };

interface MemoryEmbeddingIndexStatusBase {
  recordCount: number;
  readyCount: number;
  pendingCount: number;
  failedCount: number;
  records: MemoryEmbeddingRecordStatus[];
}

export type MemoryEmbeddingIndexStatus =
  | (MemoryEmbeddingIndexStatusBase & { state: 'ready'; builtAt: string })
  | (MemoryEmbeddingIndexStatusBase & {
      state: 'needs-rebuild';
      reason: 'missing' | 'records-changed' | 'invalid' | 'failed';
    });

export interface MemoryEmbeddingIndexBuildProgress extends MemoryEmbeddingIndexStatusBase {
  currentMemoryId: string | null;
}

export interface EmbeddingMemoryRetrieverOptions {
  minimumSimilarity?: number;
}

export interface MemoryServiceOptions {
  createId?: () => string;
  now?: () => Date;
  retriever?: MemoryRetriever;
}

const ignoredTerms = new Set([
  'and',
  'are',
  'at',
  'den',
  'der',
  'det',
  'du',
  'eller',
  'en',
  'er',
  'et',
  'for',
  'fra',
  'har',
  'hvad',
  'i',
  'in',
  'is',
  'jeg',
  'med',
  'of',
  'og',
  'om',
  'on',
  'på',
  'som',
  'the',
  'til',
  'to',
  'vi',
  'what',
  'with',
  'you',
]);

function normalizedTerms(value: string): string[] {
  const terms = value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  return (terms ?? []).filter((term) => term.length > 1 && !ignoredTerms.has(term));
}

function newestFirst(left: MemoryRecord, right: MemoryRecord): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (!left.length || left.length !== right.length) {
    throw new Error('Embedding provider returned vectors with inconsistent dimensions.');
  }
  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      throw new Error('Embedding provider returned a non-finite vector value.');
    }
    dotProduct += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return dotProduct / Math.sqrt(leftMagnitude * rightMagnitude);
}

// Conservative cross-provider ceiling for a single embedding input. Most embedding models cap
// out well under this (a few hundred to a few thousand tokens); at roughly 4 characters per
// token this stays under even the smallest common context windows. The query is only used to
// find semantically similar memories, so clamping it never affects what the agent actually sees
// — the full, untruncated prompt still goes to the chat model. Without this, a long user prompt
// (nothing unusual — every other IRIS surface accepts one) makes the embedding provider reject
// the request outright, and memory recall silently stops working for that turn.
export const embeddingQueryCharacterLimit = 6000;

function clampEmbeddingQuery(query: string): string {
  return query.length > embeddingQueryCharacterLimit
    ? query.slice(0, embeddingQueryCharacterLimit)
    : query;
}

function sourceFingerprint(record: MemoryRecord): string {
  const source = `${record.id}\u0000${record.updatedAt}\u0000${record.content}`;
  let hash = 2166136261;
  for (const character of source) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function validVector(vector: readonly number[], dimensions?: number): boolean {
  return (
    vector.length > 0 &&
    (dimensions === undefined || vector.length === dimensions) &&
    vector.every(Number.isFinite)
  );
}

function sameScope(left: MemoryEmbeddingScope, right: MemoryEmbeddingScope): boolean {
  return left.providerId === right.providerId && left.model === right.model;
}

function pendingIndexStatus(
  records: readonly MemoryRecord[],
  reason: 'missing' | 'invalid',
): MemoryEmbeddingIndexStatus {
  return {
    state: 'needs-rebuild',
    reason,
    recordCount: records.length,
    readyCount: 0,
    pendingCount: records.length,
    failedCount: 0,
    records: records.map((record) => ({ memoryId: record.id, state: 'pending' })),
  };
}

function statusCounts(records: MemoryEmbeddingRecordStatus[]): MemoryEmbeddingIndexStatusBase {
  return {
    recordCount: records.length,
    readyCount: records.filter((record) => record.state === 'ready').length,
    pendingCount: records.filter((record) => record.state === 'pending').length,
    failedCount: records.filter((record) => record.state === 'failed').length,
    records,
  };
}

export function inspectMemoryEmbeddingIndex(
  index: MemoryEmbeddingIndex | null,
  records: readonly MemoryRecord[],
  scope: MemoryEmbeddingScope,
): MemoryEmbeddingIndexStatus {
  if (!index || !sameScope(index.scope, scope)) {
    return pendingIndexStatus(records, 'missing');
  }
  if (!index.updatedAt || Number.isNaN(Date.parse(index.updatedAt))) {
    return pendingIndexStatus(records, 'invalid');
  }
  const entries = new Map(index.entries.map((entry) => [entry.memoryId, entry]));
  const failures = new Map(index.failures.map((failure) => [failure.memoryId, failure]));
  if (entries.size !== index.entries.length || failures.size !== index.failures.length) {
    return pendingIndexStatus(records, 'invalid');
  }
  let dimensions: number | undefined;
  let invalid = false;
  const recordStatuses: MemoryEmbeddingRecordStatus[] = [];
  for (const record of records) {
    const entry = entries.get(record.id);
    if (entry?.sourceFingerprint === sourceFingerprint(record)) {
      dimensions ??= entry.vector.length;
      if (validVector(entry.vector, dimensions)) {
        recordStatuses.push({ memoryId: record.id, state: 'ready' });
        continue;
      }
      invalid = true;
    }
    const failure = failures.get(record.id);
    if (failure?.sourceFingerprint === sourceFingerprint(record)) {
      recordStatuses.push({
        memoryId: record.id,
        state: 'failed',
        attempts: failure.attempts,
        error: failure.error,
        lastAttemptAt: failure.lastAttemptAt,
      });
    } else {
      recordStatuses.push({ memoryId: record.id, state: 'pending' });
    }
  }
  const counts = statusCounts(recordStatuses);
  const exactRecordSet =
    index.entries.length === records.length &&
    index.failures.length === 0 &&
    counts.readyCount === records.length;
  if (exactRecordSet && index.builtAt && !Number.isNaN(Date.parse(index.builtAt)) && !invalid) {
    return { state: 'ready', builtAt: index.builtAt, ...counts };
  }
  return {
    state: 'needs-rebuild',
    reason: invalid ? 'invalid' : counts.failedCount ? 'failed' : 'records-changed',
    ...counts,
  };
}

export class MemoryEmbeddingIndexService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: MemoryEmbeddingIndexRepository,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async status(
    records: readonly MemoryRecord[],
    scope: MemoryEmbeddingScope,
  ): Promise<MemoryEmbeddingIndexStatus> {
    return inspectMemoryEmbeddingIndex(await this.repository.get(scope), records, scope);
  }

  async rebuild(
    records: readonly MemoryRecord[],
    scope: MemoryEmbeddingScope,
    embedder: MemoryEmbedder,
    onProgress?: (progress: MemoryEmbeddingIndexBuildProgress) => void,
  ): Promise<MemoryEmbeddingIndex> {
    const existing = await this.repository.get(scope);
    const currentFingerprints = new Map(
      records.map((record) => [record.id, sourceFingerprint(record)]),
    );
    const candidateEntriesById = new Map<string, MemoryEmbeddingIndexEntry>();
    for (const entry of existing?.entries ?? []) {
      if (
        !candidateEntriesById.has(entry.memoryId) &&
        currentFingerprints.get(entry.memoryId) === entry.sourceFingerprint &&
        validVector(entry.vector)
      ) {
        candidateEntriesById.set(entry.memoryId, entry);
      }
    }
    const candidateEntries = [...candidateEntriesById.values()];
    const dimensionFrequency = new Map<number, number>();
    for (const entry of candidateEntries) {
      dimensionFrequency.set(
        entry.vector.length,
        (dimensionFrequency.get(entry.vector.length) ?? 0) + 1,
      );
    }
    let dimensions = [...dimensionFrequency.entries()].sort(
      ([leftDimension, leftCount], [rightDimension, rightCount]) =>
        rightCount - leftCount || leftDimension - rightDimension,
    )[0]?.[0];
    const retainedEntries = candidateEntries.filter((entry) => entry.vector.length === dimensions);
    const retainedIds = new Set(retainedEntries.map((entry) => entry.memoryId));
    const retainedFailuresById = new Map<string, MemoryEmbeddingIndexFailure>();
    for (const failure of existing?.failures ?? []) {
      if (
        !retainedIds.has(failure.memoryId) &&
        !retainedFailuresById.has(failure.memoryId) &&
        currentFingerprints.get(failure.memoryId) === failure.sourceFingerprint
      ) {
        retainedFailuresById.set(failure.memoryId, failure);
      }
    }
    const retainedFailures = [...retainedFailuresById.values()];
    const timestamp = this.now().toISOString();
    const index: MemoryEmbeddingIndex = {
      scope: { ...scope },
      builtAt: null,
      updatedAt: timestamp,
      entries: retainedEntries.map((entry) => ({ ...entry, vector: [...entry.vector] })),
      failures: retainedFailures.map((failure) => ({ ...failure })),
    };
    await this.repository.save(index);

    const reportProgress = (currentMemoryId: string | null) => {
      const status = inspectMemoryEmbeddingIndex(index, records, scope);
      onProgress?.({
        recordCount: status.recordCount,
        readyCount: status.readyCount,
        pendingCount: status.pendingCount,
        failedCount: status.failedCount,
        records: status.records,
        currentMemoryId,
      });
    };
    reportProgress(null);

    for (const record of records) {
      if (index.entries.some((entry) => entry.memoryId === record.id)) continue;
      reportProgress(record.id);
      const previousFailure = index.failures.find((failure) => failure.memoryId === record.id);
      const attemptedAt = this.now().toISOString();
      try {
        const vectors = await embedder.embed([record.content]);
        const vector = vectors[0];
        if (vectors.length !== 1 || !vector || !validVector(vector, dimensions)) {
          throw new Error('Embedding provider returned an invalid index vector.');
        }
        dimensions ??= vector.length;
        index.entries.push({
          memoryId: record.id,
          sourceFingerprint: sourceFingerprint(record),
          vector: [...vector],
        });
        index.failures = index.failures.filter((failure) => failure.memoryId !== record.id);
      } catch (error) {
        index.failures = [
          ...index.failures.filter((failure) => failure.memoryId !== record.id),
          {
            memoryId: record.id,
            sourceFingerprint: sourceFingerprint(record),
            attempts: (previousFailure?.attempts ?? 0) + 1,
            error: error instanceof Error ? error.message : 'Embedding failed for this record.',
            lastAttemptAt: attemptedAt,
          },
        ];
      }
      index.updatedAt = this.now().toISOString();
      await this.repository.save(index);
      reportProgress(null);
    }

    if (index.entries.length === records.length && index.failures.length === 0) {
      index.builtAt = this.now().toISOString();
      index.updatedAt = index.builtAt;
      await this.repository.save(index);
    }
    reportProgress(null);
    return index;
  }
}

export class LocalLexicalMemoryRetriever implements MemoryRetriever {
  async retrieve(
    records: readonly MemoryRecord[],
    request: MemoryRetrievalRequest,
  ): Promise<MemoryRecord[]> {
    const limit = Math.max(0, Math.floor(request.limit));
    const queryTerms = [...new Set(normalizedTerms(request.query).slice(0, 64))];
    if (!limit || !queryTerms.length || !records.length) return [];

    const indexed = records.map((record) => ({
      record,
      terms: normalizedTerms(record.content).slice(0, 512),
    }));
    const documentFrequency = new Map<string, number>();
    for (const term of queryTerms) {
      documentFrequency.set(
        term,
        indexed.reduce((count, entry) => count + Number(entry.terms.includes(term)), 0),
      );
    }

    return indexed
      .map(({ record, terms }) => {
        const termCounts = new Map<string, number>();
        for (const term of terms) termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
        const score = queryTerms.reduce((total, term) => {
          const frequency = termCounts.get(term) ?? 0;
          if (!frequency) return total;
          const inverseDocumentFrequency =
            Math.log((records.length + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;
          return total + inverseDocumentFrequency * (1 + Math.log(frequency));
        }, 0);
        return { record, score };
      })
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score || newestFirst(left.record, right.record))
      .slice(0, limit)
      .map((match) => match.record);
  }
}

export class EmbeddingMemoryRetriever implements MemoryRetriever {
  private readonly minimumSimilarity: number;

  constructor(
    private readonly embedder: MemoryEmbedder,
    options: EmbeddingMemoryRetrieverOptions = {},
  ) {
    this.minimumSimilarity = options.minimumSimilarity ?? 0.2;
  }

  async retrieve(
    records: readonly MemoryRecord[],
    request: MemoryRetrievalRequest,
  ): Promise<MemoryRecord[]> {
    const limit = Math.max(0, Math.floor(request.limit));
    const query = clampEmbeddingQuery(request.query.trim());
    if (!limit || !query || !records.length) return [];

    const vectors = await this.embedder.embed([query, ...records.map((record) => record.content)]);
    if (vectors.length !== records.length + 1) {
      throw new Error('Embedding provider returned an unexpected number of vectors.');
    }
    const queryVector = vectors[0];
    if (!queryVector) throw new Error('Embedding provider returned no query vector.');

    return records
      .map((record, index) => {
        const vector = vectors[index + 1];
        if (!vector) throw new Error('Embedding provider returned no vector for a memory record.');
        return { record, score: cosineSimilarity(queryVector, vector) };
      })
      .filter((match) => match.score >= this.minimumSimilarity)
      .sort((left, right) => right.score - left.score || newestFirst(left.record, right.record))
      .slice(0, limit)
      .map((match) => match.record);
  }
}

export class IndexedEmbeddingMemoryRetriever implements MemoryRetriever {
  private readonly minimumSimilarity: number;

  constructor(
    private readonly embedder: MemoryEmbedder,
    private readonly indexRepository: MemoryEmbeddingIndexRepository,
    private readonly scope: MemoryEmbeddingScope,
    options: EmbeddingMemoryRetrieverOptions = {},
  ) {
    this.minimumSimilarity = options.minimumSimilarity ?? 0.2;
  }

  async retrieve(
    records: readonly MemoryRecord[],
    request: MemoryRetrievalRequest,
  ): Promise<MemoryRecord[]> {
    const limit = Math.max(0, Math.floor(request.limit));
    const query = clampEmbeddingQuery(request.query.trim());
    if (!limit || !query || !records.length) return [];

    let index = await this.indexRepository.get(this.scope);
    if (inspectMemoryEmbeddingIndex(index, records, this.scope).state !== 'ready' || !index) {
      // Self-heal: a memory written this session leaves the index stale. Incrementally embed the
      // new or changed records so recall keeps working without a manual rebuild. Per-record
      // embedding failures are recorded inside the index rather than thrown, so a single bad
      // record never blocks the agent turn.
      index = await new MemoryEmbeddingIndexService(this.indexRepository).rebuild(
        records,
        this.scope,
        this.embedder,
      );
    }
    if (!index.entries.length) return [];

    const queryVectors = await this.embedder.embed([query]);
    const queryVector = queryVectors[0];
    const dimensions = index.entries[0]?.vector.length;
    if (queryVectors.length !== 1 || !queryVector || !validVector(queryVector, dimensions)) {
      throw new Error('Embedding provider returned an invalid query vector.');
    }
    const indexedById = new Map(index.entries.map((entry) => [entry.memoryId, entry.vector]));
    return records
      // A record with no vector could not be embedded (e.g. a transient failure); skip it this
      // turn rather than failing the whole retrieval.
      .flatMap((record) => {
        const vector = indexedById.get(record.id);
        return vector ? [{ record, score: cosineSimilarity(queryVector, vector) }] : [];
      })
      .filter((match) => match.score >= this.minimumSimilarity)
      .sort((left, right) => right.score - left.score || newestFirst(left.record, right.record))
      .slice(0, limit)
      .map((match) => match.record);
  }
}

export class MemoryService {
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly retriever: MemoryRetriever;

  constructor(
    private readonly repository: MemoryRepository,
    options: MemoryServiceOptions = {},
  ) {
    this.createId = options.createId ?? (() => `memory-${crypto.randomUUID()}`);
    this.now = options.now ?? (() => new Date());
    this.retriever = options.retriever ?? new LocalLexicalMemoryRetriever();
  }

  list(): Promise<MemoryRecord[]> {
    return this.repository.list();
  }

  async listForAgent(agent: AgentDefinition): Promise<MemoryRecord[]> {
    if (agent.memoryAccess !== 'read') return [];
    return this.repository.list();
  }

  async recallForAgent(
    agent: AgentDefinition,
    query: string,
    limit: number,
  ): Promise<MemoryRecord[]> {
    if (agent.memoryAccess !== 'read') return [];
    return this.retriever.retrieve(await this.repository.list(), { query, limit });
  }

  async remember(content: string): Promise<MemoryRecord> {
    const timestamp = this.now().toISOString();
    return this.saveRecord(content, timestamp, {
      source: 'user',
      actorId: 'workspace-user',
      actorName: 'Workspace user',
      capturedAt: timestamp,
    });
  }

  async rememberForAgent(
    content: string,
    agent: Pick<AgentDefinition, 'id' | 'name'>,
    turnId: string,
    toolCallId: string,
  ): Promise<MemoryRecord> {
    const normalizedTurnId = turnId.trim();
    const normalizedToolCallId = toolCallId.trim();
    if (!normalizedTurnId) throw new Error('Agent memory requires an originating turn.');
    if (!normalizedToolCallId) throw new Error('Agent memory requires an originating tool call.');
    const timestamp = this.now().toISOString();
    return this.saveRecord(content, timestamp, {
      source: 'agent',
      actorId: agent.id,
      actorName: agent.name,
      capturedAt: timestamp,
      turnId: normalizedTurnId,
      toolCallId: normalizedToolCallId,
    });
  }

  private async saveRecord(
    content: string,
    timestamp: string,
    provenance: MemoryProvenance,
  ): Promise<MemoryRecord> {
    const normalized = content.trim();
    if (!normalized) throw new Error('Memory content cannot be empty.');
    const record: MemoryRecord = {
      id: this.createId(),
      content: normalized,
      createdAt: timestamp,
      updatedAt: timestamp,
      provenance,
    };
    await this.repository.save(record);
    return record;
  }

  forget(id: string): Promise<void> {
    return this.repository.remove(id);
  }
}
