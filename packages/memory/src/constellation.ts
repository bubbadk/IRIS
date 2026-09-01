import type { MemoryRecord } from './index';

/**
 * Memory Constellation model: turns memory records plus historical retrieval
 * context packs into a star-map — nodes are memories, links connect memories
 * retrieved together, and per-turn traces power the live retrieval glow.
 * Everything here is derived from real persisted data; nothing is simulated.
 */

export interface ConstellationNode {
  memoryId: string;
  content: string;
  speaker: string;
  createdAt: string;
  /** How many recorded turns retrieved this memory. */
  usageCount: number;
  /** ISO timestamp of the most recent turn that retrieved it, if any. */
  lastUsedAt: string | null;
  /** The prompts (most recent last) that retrieved this memory. */
  retrievedBy: string[];
}

export interface ConstellationLink {
  fromId: string;
  toId: string;
  /** Co-retrieval weight: how often the two memories were selected together. */
  weight: number;
}

export interface ConstellationTrace {
  turnId: string;
  prompt: string;
  createdAt: string;
  /** Selected memory ids in retrieval rank order (rank 1 first). */
  rankedIds: string[];
}

export interface Constellation {
  nodes: ConstellationNode[];
  links: ConstellationLink[];
  traces: ConstellationTrace[];
}

interface SelectionLike {
  source: string;
  sourceId: string;
}

interface PackLike {
  turnId: string;
  prompt: string;
  createdAt: string;
  selections: readonly SelectionLike[];
}

/**
 * Builds the constellation from memory records and context packs. Selections
 * that reference deleted memories are ignored; records never retrieved still
 * appear as dormant stars. Links connect memories selected in the same turn;
 * order within the turn does not affect the link weight.
 */
export function buildConstellation(
  records: readonly MemoryRecord[],
  packs: readonly PackLike[],
): Constellation {
  const nodesById = new Map<string, ConstellationNode>();
  for (const record of records) {
    nodesById.set(record.id, {
      memoryId: record.id,
      content: record.content,
      speaker: record.provenance?.actorName ?? 'Unknown',
      createdAt: record.createdAt,
      usageCount: 0,
      lastUsedAt: null,
      retrievedBy: [],
    });
  }

  const linkWeights = new Map<string, number>();
  const traces: ConstellationTrace[] = [];

  const orderedPacks = [...packs].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  for (const pack of orderedPacks) {
    // Selections referencing deleted memories are ignored throughout.
    const memoryIds = [
      ...new Set(
        pack.selections
          .filter((selection) => selection.source === 'memory')
          .map((selection) => selection.sourceId),
      ),
    ].filter((id) => nodesById.has(id));
    if (!memoryIds.length) continue;

    traces.push({
      turnId: pack.turnId,
      prompt: pack.prompt,
      createdAt: pack.createdAt,
      rankedIds: memoryIds,
    });

    const at = pack.createdAt;
    for (const id of memoryIds) {
      const node = nodesById.get(id);
      if (!node) continue;
      node.usageCount += 1;
      node.lastUsedAt = at;
      node.retrievedBy.push(pack.prompt);
    }
    for (let i = 0; i < memoryIds.length; i++) {
      for (let j = i + 1; j < memoryIds.length; j++) {
        const [fromId, toId] = [memoryIds[i], memoryIds[j]].sort();
        const key = `${fromId}::${toId}`;
        linkWeights.set(key, (linkWeights.get(key) ?? 0) + 1);
      }
    }
  }

  const links: ConstellationLink[] = [...linkWeights.entries()].map(([key, weight]) => {
    const [fromId, toId] = key.split('::');
    return { fromId, toId, weight };
  });

  return { nodes: [...nodesById.values()], links, traces };
}

/**
 * Filters constellation traces to the window [fromMs, toMs] (epoch millis,
 * inclusive), used by the timeline scrubber. Nodes are filtered separately by
 * their record creation date; traces define what the agent retrieved when.
 */
export function filterTracesByTime(
  traces: readonly ConstellationTrace[],
  fromMs: number,
  toMs: number,
): ConstellationTrace[] {
  return traces.filter((trace) => {
    const at = Date.parse(trace.createdAt);
    return !Number.isNaN(at) && at >= fromMs && at <= toMs;
  });
}
