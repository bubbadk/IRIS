import { invoke } from '@tauri-apps/api/core';
import type { RegisteredTool } from '@iris/tools';

const snapshotKey = 'iris.janitor.projectcockpit.snapshots';
const snapshotLimit = 20;
const snapshotBodyLimit = 64 * 1024;

type MutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface ProjectCockpitResponse {
  status: number;
  body: string;
}

interface MutationSnapshot {
  id: string;
  capturedAt: string;
  method: MutationMethod;
  path: string;
  currentBody: string;
  currentFingerprint: string;
  proposedBody: string;
}

type DiffLine = { kind: 'same' | 'removed' | 'added'; text: string };

function diffLines(previous: string, next: string): DiffLine[] {
  const before = previous.split('\n');
  const after = next.split('\n');
  const lines: DiffLine[] = [];
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    if (before[index] === after[index]) {
      if (before[index] !== undefined) lines.push({ kind: 'same', text: before[index] });
    } else {
      if (before[index] !== undefined) lines.push({ kind: 'removed', text: before[index] });
      if (after[index] !== undefined) lines.push({ kind: 'added', text: after[index] });
    }
  }
  return lines.slice(0, 240);
}

function isMutationMethod(value: string | undefined): value is MutationMethod {
  return value === 'POST' || value === 'PUT' || value === 'PATCH' || value === 'DELETE';
}

function responseBody(response: ProjectCockpitResponse): string {
  if (response.body.length > snapshotBodyLimit) {
    throw new Error('ProjectCockpit responses over 64 KiB cannot be used for a mutation preflight.');
  }
  return response.body;
}

function fingerprint(value: string): string {
  // A deterministic, non-secret change marker for stale-preflight detection.
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function readSnapshots(): MutationSnapshot[] {
  try {
    const raw = globalThis.localStorage?.getItem(snapshotKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is MutationSnapshot => {
      if (!item || typeof item !== 'object') return false;
      const value = item as Partial<MutationSnapshot>;
      return (
        typeof value.id === 'string' &&
        typeof value.capturedAt === 'string' &&
        isMutationMethod(value.method) &&
        typeof value.path === 'string' &&
        typeof value.currentBody === 'string' &&
        typeof value.currentFingerprint === 'string' &&
        typeof value.proposedBody === 'string'
      );
    });
  } catch {
    return [];
  }
}

function saveSnapshot(snapshot: MutationSnapshot): void {
  const snapshots = [snapshot, ...readSnapshots().filter((item) => item.id !== snapshot.id)].slice(
    0,
    snapshotLimit,
  );
  globalThis.localStorage?.setItem(snapshotKey, JSON.stringify(snapshots));
}

function consumeSnapshot(id: string): MutationSnapshot {
  const snapshot = loadSnapshot(id);
  const remaining = readSnapshots().filter((item) => item.id !== id);
  globalThis.localStorage?.setItem(snapshotKey, JSON.stringify(remaining));
  return snapshot;
}

function loadSnapshot(id: string): MutationSnapshot {
  const snapshot = readSnapshots().find((item) => item.id === id);
  if (!snapshot) throw new Error(`Unknown or expired ProjectCockpit preflight: ${id}`);
  return snapshot;
}

async function request(
  method: string,
  path: string,
  body: Record<string, unknown> | null,
): Promise<ProjectCockpitResponse> {
  return invoke<ProjectCockpitResponse>('janitor_projectcockpit_request', { method, path, body });
}

function validatePath(path: unknown): asserts path is string {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/api/') ||
    path.includes('..') ||
    path.includes('?') ||
    path.length > 240
  ) {
    throw new Error('ProjectCockpit paths must be relative /api/ paths without traversal or query strings.');
  }
}

function proposedBody(body: unknown): string {
  if (body === undefined) return '';
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('ProjectCockpit mutation bodies must be JSON objects.');
  }
  const encoded = JSON.stringify(body);
  if (encoded.length > snapshotBodyLimit) throw new Error('ProjectCockpit mutation bodies are limited to 64 KiB.');
  return encoded;
}

export function createJanitorProjectCockpitTool(): RegisteredTool {
  return {
    id: 'janitor.projectcockpit',
    name: 'Use ProjectCockpit API',
    description:
      'Reads the live ProjectCockpit API. Mutations require a preflight snapshot/diff and stale-check before apply, then a live verification request.',
    risk: 'execute',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['request', 'preview', 'apply'] },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        path: { type: 'string', minLength: 1, maxLength: 240 },
        body: { type: 'object' },
        snapshotId: { type: 'string', minLength: 1, maxLength: 80 },
      },
      required: ['method', 'path'],
      additionalProperties: false,
    },
    async run(input) {
      if (!input || typeof input !== 'object')
        throw new Error('ProjectCockpit input must be an object.');
      const value = input as { method?: string; path?: string; body?: Record<string, unknown> };
      const method = value.method?.toUpperCase();
      if (!method || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
        throw new Error('ProjectCockpit needs a supported HTTP method.');
      validatePath(value.path);
      const operation = (input as { operation?: string }).operation ?? 'request';
      if (operation === 'request') {
        if (method !== 'GET') {
          throw new Error('ProjectCockpit mutations require operation=preview, then operation=apply with its snapshotId.');
        }
        return request(method, value.path, null);
      }
      if (!isMutationMethod(method)) throw new Error('ProjectCockpit preflight only applies to mutations.');
      const nextBody = proposedBody(value.body);
      if (operation === 'preview') {
        const current = await request('GET', value.path, null);
        const currentBody = responseBody(current);
        const snapshot: MutationSnapshot = {
          id: crypto.randomUUID(),
          capturedAt: new Date().toISOString(),
          method,
          path: value.path,
          currentBody,
          currentFingerprint: fingerprint(currentBody),
          proposedBody: nextBody,
        };
        saveSnapshot(snapshot);
        return {
          status: 'preview',
          snapshotId: snapshot.id,
          capturedAt: snapshot.capturedAt,
          method,
          path: value.path,
          currentStatus: current.status,
          currentBody,
          proposedBody: nextBody || null,
          changed: currentBody !== nextBody,
          diff: diffLines(currentBody, nextBody),
          currentFingerprint: snapshot.currentFingerprint,
        };
      }
      if (operation !== 'apply') throw new Error('ProjectCockpit operation must be request, preview or apply.');
      const snapshotId = (input as { snapshotId?: string }).snapshotId;
      if (!snapshotId?.trim()) throw new Error('ProjectCockpit apply requires the snapshotId from a preview.');
      const snapshot = loadSnapshot(snapshotId);
      if (snapshot.method !== method || snapshot.path !== value.path || snapshot.proposedBody !== nextBody) {
        throw new Error('ProjectCockpit apply does not match the approved preflight. Create a new preview.');
      }
      const current = await request('GET', value.path, null);
      const currentBody = responseBody(current);
      if (fingerprint(currentBody) !== snapshot.currentFingerprint) {
        throw new Error('ProjectCockpit resource changed after preview. Create a new preflight before applying.');
      }
      // Applying a preflight is deliberately single-use. This prevents a repeated model/tool
      // call from replaying the same approved mutation after the resource has changed.
      consumeSnapshot(snapshotId);
      const mutation = await request(method, value.path, value.body ?? null);
      const verification = await request('GET', value.path, null);
      return {
        status: 'applied',
        method,
        path: value.path,
        mutation,
        verification,
        verified: verification.status >= 200 && verification.status < 300,
        snapshotId: snapshot.id,
      };
    },
  };
}
