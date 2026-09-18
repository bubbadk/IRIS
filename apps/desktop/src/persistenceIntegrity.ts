/**
 * IRIS Phase 2B — persistence integrity primitives.
 *
 * Invariant: **a parse failure must fail closed without destroying the original persistent value.**
 *
 * Every persistent read distinguishes three cases:
 *  - the key has never been written  -> the repository's legitimate empty state;
 *  - the key holds valid data        -> decoded and validated;
 *  - the key holds anything else     -> `PersistedDataError`, with the stored value untouched.
 *
 * The failure mode this module exists to prevent is a read that swallows a parse error, returns an
 * empty structure, and whose caller then writes that empty structure back over the user's data.
 * No code here ever writes, repairs, migrates or re-formats stored data, and no error message
 * contains the stored payload.
 */

/** Why a persisted document could not be read. Used for diagnostics, never for guessing. */
export type PersistedDataFailure =
  | 'malformed-json'
  | 'wrong-root-type'
  | 'invalid-record'
  | 'duplicate-record';

export class PersistedDataError extends Error {
  constructor(
    readonly repository: string,
    readonly storageKey: string,
    readonly failure: PersistedDataFailure,
    readonly detail: string,
  ) {
    super(
      `Failed to read persisted ${repository} (${storageKey}): ${detail}. ` +
        'Existing data was retained; the stored value was not replaced with an empty structure.',
    );
    this.name = 'PersistedDataError';
  }
}

function describeRoot(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a JSON array';
  if (typeof value === 'object') return 'a JSON object';
  if (typeof value === 'string') return 'a JSON string';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'a boolean';
  return typeof value;
}

/**
 * A keyed object document (`Record<string, T>`) is always read into a null-prototype object so a
 * stored `"__proto__"` key cannot silently alter the prototype instead of becoming a record.
 */
function emptyRecord<V>(): Record<string, V> {
  return Object.create(null) as Record<string, V>;
}

interface DocumentIdentity {
  repository: string;
  storageKey: string;
}

/**
 * Parses the raw stored string and enforces the document's root type. A missing key is reported
 * separately (`null`) so callers can return their legitimate empty state instead of failing.
 */
function parseDocument(
  identity: DocumentIdentity,
  raw: string | null,
  root: 'array' | 'object',
): { present: false; value: undefined } | { present: true; value: unknown } {
  if (raw === null) return { present: false, value: undefined };
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new PersistedDataError(
      identity.repository,
      identity.storageKey,
      'malformed-json',
      'the stored value is not valid JSON',
    );
  }
  if (root === 'array' && !Array.isArray(value)) {
    throw new PersistedDataError(
      identity.repository,
      identity.storageKey,
      'wrong-root-type',
      `a JSON array document was required but ${describeRoot(value)} was stored`,
    );
  }
  if (root === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new PersistedDataError(
      identity.repository,
      identity.storageKey,
      'wrong-root-type',
      `a JSON object document was required but ${describeRoot(value)} was stored`,
    );
  }
  return { present: true, value };
}

export interface PersistedArrayRead<T> extends DocumentIdentity {
  raw: string | null;
  /** Returns the normalized record, or `null` when the record fails repository validation. */
  decode: (value: unknown, index: number) => T | null;
  /** Stable identity used to reject duplicate records. Omit for documents without unique ids. */
  identity?: (record: T) => string;
}

/**
 * Reads an array document. Any element that fails validation fails the whole read: dropping the
 * element would let the next save persist a silently shortened collection.
 */
export function readPersistedArray<T>(options: PersistedArrayRead<T>): T[] {
  const document = parseDocument(options, options.raw, 'array');
  if (!document.present) return [];
  const values = document.value as unknown[];
  const records: T[] = [];
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const record = options.decode(value, index);
    if (record === null) {
      throw new PersistedDataError(
        options.repository,
        options.storageKey,
        'invalid-record',
        `record ${index + 1} of ${values.length} failed ${options.repository} validation`,
      );
    }
    if (options.identity) {
      const id = options.identity(record);
      if (seen.has(id)) {
        throw new PersistedDataError(
          options.repository,
          options.storageKey,
          'duplicate-record',
          `record ${index + 1} of ${values.length} repeats identity ${JSON.stringify(id).slice(0, 120)}`,
        );
      }
      seen.add(id);
    }
    records.push(record);
  });
  return records;
}

export interface PersistedKeyedObjectRead<T> extends DocumentIdentity {
  raw: string | null;
  /** Returns the normalized record, or `null` when the record fails repository validation. */
  decode: (key: string, value: unknown) => T | null;
}

/**
 * Reads a keyed object document (`Record<string, T>`). Arrays are rejected at the root: JavaScript
 * would accept named properties on an array, but `JSON.stringify` would then drop them, so a save
 * could report success while the change disappeared.
 */
export function readPersistedKeyedObject<T>(options: PersistedKeyedObjectRead<T>): Record<string, T> {
  const document = parseDocument(options, options.raw, 'object');
  if (!document.present) return emptyRecord<T>();
  const entries = Object.entries(document.value as Record<string, unknown>);
  const records = emptyRecord<T>();
  for (const [key, value] of entries) {
    const record = options.decode(key, value);
    if (record === null) {
      throw new PersistedDataError(
        options.repository,
        options.storageKey,
        'invalid-record',
        `the value stored for key ${JSON.stringify(key).slice(0, 120)} failed ${options.repository} validation`,
      );
    }
    records[key] = record;
  }
  return records;
}

export interface PersistedValueRead<T> extends DocumentIdentity {
  raw: string | null;
  /** Returns the normalized record, or `null` when the record fails repository validation. */
  decode: (value: unknown) => T | null;
}

/**
 * Reads a single-object document. A missing key yields `null`; a corrupt or wrongly shaped value
 * fails the read instead of being reported as "not configured".
 */
export function readPersistedValue<T>(options: PersistedValueRead<T>): T | null {
  if (options.raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(options.raw) as unknown;
  } catch {
    throw new PersistedDataError(
      options.repository,
      options.storageKey,
      'malformed-json',
      'the stored value is not valid JSON',
    );
  }
  const record = options.decode(value);
  if (record === null) {
    throw new PersistedDataError(
      options.repository,
      options.storageKey,
      'invalid-record',
      `the stored value failed ${options.repository} validation`,
    );
  }
  return record;
}

/** True for a JSON object that is neither `null` nor an array. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
