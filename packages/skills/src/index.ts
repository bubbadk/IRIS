import type { AgentDefinition } from '@iris/core';

export const skillNameLimit = 80;
export const skillSummaryLimit = 200;
export const skillInstructionsLimit = 8000;
export const skillBundleFilePathLimit = 240;
export const skillBundleFileContentLimit = 256 * 1024;
export const skillBundleFileLimit = 100;
export const skillBundleToolLimit = 32;

export type SkillOrigin =
  | { kind: 'local' }
  | {
      /** Authored by an agent during a task through the permission-gated skill-capture tool. */
      kind: 'captured';
      agentId: string;
      agentName: string;
      turnId: string;
      capturedAt: string;
    }
  | {
      kind: 'imported';
      catalogId: string;
      catalogName: string;
      slug: string;
      sourceUrl?: string;
      /** The repository link recorded by the catalog, when different from sourceUrl. */
      repositoryUrl?: string;
      importedAt: string;
      sourceFingerprint?: string;
      lastCheckedAt?: string;
      lastCheck?: 'unchanged' | 'changed' | 'unavailable' | 'moved';
    };

export interface SkillDefinition {
  version: 1;
  id: string;
  name: string;
  summary: string;
  instructions: string;
  enabled: boolean;
  /** Optional bundled material. Declarations never grant runtime tool authority. */
  bundle?: SkillBundle;
  /** Absent on records written before skill import existed; treat those as locally authored. */
  origin?: SkillOrigin;
  createdAt: string;
  updatedAt: string;
}

export interface SkillBundleFile {
  path: string;
  content: string;
}

export interface SkillBundleToolDeclaration {
  id: string;
  name: string;
  description: string;
  risk: 'read' | 'write' | 'execute' | 'external';
  inputSchema?: Record<string, unknown>;
}

export interface SkillBundleSource {
  /** The source is descriptive provenance only; it never grants execution authority. */
  url?: string;
  fingerprint?: string;
  importedAt?: string;
  lastCheckedAt?: string;
  lastCheck?: ImportedSkillSourceStatus;
}

export interface SkillBundle {
  version: 1;
  files: SkillBundleFile[];
  toolDeclarations: SkillBundleToolDeclaration[];
  provenance: 'local' | 'imported';
  source?: SkillBundleSource;
}

/** A host may inspect a registration plan, but it must not mutate the persisted declaration. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

/**
 * A bundled declaration is descriptive data until a capability provider and permission
 * registration have been deliberately supplied by the host. Keeping this boundary in the
 * skills package prevents persistence code from accidentally becoming a tool factory.
 */
export interface SkillBundleRegistrationPlan {
  readonly status: 'unavailable';
  readonly skillId: string;
  readonly declarations: readonly DeepReadonly<SkillBundleToolDeclaration>[];
  readonly reason: 'provider-and-permission-wiring-required';
}

/**
 * Runtime capability supplied by a host/provider. Providers are deliberately not part of a
 * persisted SkillBundle: a declaration can describe a capability, but only a host-owned runtime
 * implementation may execute it.
 */
export interface SkillBundleCapabilityContext {
  agentId: string;
  agentName: string;
  turnId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
}

export interface SkillBundleCapabilityProvider {
  skillId: string;
  toolId: string;
  run(input: unknown, context: SkillBundleCapabilityContext): Promise<unknown>;
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
}

export function planSkillBundleRegistration(
  skillId: string,
  bundle: SkillBundle,
): SkillBundleRegistrationPlan {
  if (!validateSkillBundle(bundle))
    throw new Error('Cannot plan registration for an invalid bundle.');
  const normalizedSkillId = skillId.trim();
  if (!normalizedSkillId) throw new Error('Cannot plan registration without a skill identifier.');
  return freezeDeep({
    status: 'unavailable',
    skillId: normalizedSkillId,
    declarations: bundle.toolDeclarations.map((tool) => ({
      ...tool,
      ...(tool.inputSchema ? { inputSchema: structuredClone(tool.inputSchema) } : {}),
    })),
    reason: 'provider-and-permission-wiring-required',
  });
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.every((item) => isJsonValue(item, seen));
  }
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).every((item) => isJsonValue(item, seen));
}

export function skillOrigin(skill: SkillDefinition): SkillOrigin {
  return skill.origin ?? { kind: 'local' };
}

function validateOrigin(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const origin = value as Record<string, unknown>;
  if (origin.kind === 'local') return true;
  if (origin.kind === 'captured') {
    return (
      typeof origin.agentId === 'string' &&
      Boolean(origin.agentId.trim()) &&
      typeof origin.agentName === 'string' &&
      Boolean(origin.agentName.trim()) &&
      typeof origin.turnId === 'string' &&
      Boolean(origin.turnId.trim()) &&
      typeof origin.capturedAt === 'string' &&
      Boolean(origin.capturedAt.trim())
    );
  }
  return (
    origin.kind === 'imported' &&
    typeof origin.catalogId === 'string' &&
    Boolean(origin.catalogId.trim()) &&
    typeof origin.catalogName === 'string' &&
    Boolean(origin.catalogName.trim()) &&
    typeof origin.slug === 'string' &&
    Boolean(origin.slug.trim()) &&
    (origin.sourceUrl === undefined || typeof origin.sourceUrl === 'string') &&
    (origin.repositoryUrl === undefined || typeof origin.repositoryUrl === 'string') &&
    typeof origin.importedAt === 'string' &&
    Boolean(origin.importedAt) &&
    (origin.sourceFingerprint === undefined || typeof origin.sourceFingerprint === 'string') &&
    (origin.lastCheckedAt === undefined || typeof origin.lastCheckedAt === 'string') &&
    (origin.lastCheck === undefined ||
      origin.lastCheck === 'unchanged' ||
      origin.lastCheck === 'changed' ||
      origin.lastCheck === 'unavailable' ||
      origin.lastCheck === 'moved')
  );
}

function validBundlePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const path = value.trim().replaceAll('\\', '/');
  return (
    path.length > 0 &&
    path.length <= skillBundleFilePathLimit &&
    !path.startsWith('/') &&
    !/^[a-zA-Z]:\//.test(path) &&
    !path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  );
}

function validateBundleSource(value: unknown): value is SkillBundleSource {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return (
    (source.url === undefined || (typeof source.url === 'string' && Boolean(source.url.trim()))) &&
    (source.fingerprint === undefined ||
      (typeof source.fingerprint === 'string' && Boolean(source.fingerprint.trim()))) &&
    (source.importedAt === undefined ||
      (typeof source.importedAt === 'string' && Boolean(source.importedAt))) &&
    (source.lastCheckedAt === undefined ||
      (typeof source.lastCheckedAt === 'string' && Boolean(source.lastCheckedAt))) &&
    (source.lastCheck === undefined ||
      source.lastCheck === 'unchanged' ||
      source.lastCheck === 'changed' ||
      source.lastCheck === 'unavailable' ||
      source.lastCheck === 'moved')
  );
}

export function validateSkillBundle(value: unknown): value is SkillBundle {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const bundle = value as Partial<SkillBundle>;
  if (
    bundle.version !== 1 ||
    (bundle.provenance !== 'local' && bundle.provenance !== 'imported') ||
    !validateBundleSource(bundle.source) ||
    !Array.isArray(bundle.files) ||
    !Array.isArray(bundle.toolDeclarations) ||
    bundle.files.length > skillBundleFileLimit ||
    bundle.toolDeclarations.length > skillBundleToolLimit
  )
    return false;
  const paths = new Set<string>();
  for (const file of bundle.files) {
    if (!file || typeof file !== 'object' || !validBundlePath(file.path)) return false;
    const path = file.path.trim().replaceAll('\\', '/');
    if (
      paths.has(path) ||
      typeof file.content !== 'string' ||
      new TextEncoder().encode(file.content).byteLength > skillBundleFileContentLimit
    )
      return false;
    paths.add(path);
  }
  const toolIds = new Set<string>();
  for (const tool of bundle.toolDeclarations) {
    if (
      !tool ||
      typeof tool !== 'object' ||
      'run' in tool ||
      'handler' in tool ||
      typeof tool.id !== 'string' ||
      !/^skill\.[a-z0-9][a-z0-9._-]*$/.test(tool.id) ||
      toolIds.has(tool.id) ||
      typeof tool.name !== 'string' ||
      !tool.name.trim() ||
      typeof tool.description !== 'string' ||
      !tool.description.trim() ||
      !['read', 'write', 'execute', 'external'].includes(tool.risk) ||
      (tool.inputSchema !== undefined &&
        (!tool.inputSchema ||
          typeof tool.inputSchema !== 'object' ||
          Array.isArray(tool.inputSchema) ||
          !isJsonValue(tool.inputSchema)))
    )
      return false;
    toolIds.add(tool.id);
  }
  return true;
}

export function cloneSkillBundle(bundle: SkillBundle): SkillBundle {
  return {
    version: 1,
    provenance: bundle.provenance,
    ...(bundle.source ? { source: { ...bundle.source } } : {}),
    files: bundle.files.map((file) => ({ path: file.path, content: file.content })),
    toolDeclarations: bundle.toolDeclarations.map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      ...(tool.inputSchema ? { inputSchema: structuredClone(tool.inputSchema) } : {}),
    })),
  };
}

/**
 * Parses the user-authored bundle manifest used by the desktop editor. The manifest is data only:
 * handlers, callbacks and other executable values are rejected by the same validator used for
 * persisted records.
 */
export function parseSkillBundleDraft(text: string): SkillBundle {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The bundled material manifest must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The bundled material manifest must be a JSON object.');
  }
  const candidate = value as Partial<SkillBundle>;
  const bundle: SkillBundle = {
    version: 1,
    provenance: 'local',
    files: Array.isArray(candidate.files) ? candidate.files : [],
    toolDeclarations: Array.isArray(candidate.toolDeclarations) ? candidate.toolDeclarations : [],
  };
  if (!validateSkillBundle(bundle)) {
    throw new Error(
      'The bundled material manifest is invalid. Use relative unique file paths and skill.* capability IDs.',
    );
  }
  return cloneSkillBundle(bundle);
}

export function serializeSkillBundleDraft(bundle: SkillBundle): string {
  if (!validateSkillBundle(bundle)) throw new Error('Cannot serialize an invalid skill bundle.');
  return JSON.stringify(
    {
      files: bundle.files,
      toolDeclarations: bundle.toolDeclarations,
    },
    null,
    2,
  );
}

/**
 * Returns bundled material as data only. A declaration is intentionally not a RegisteredTool and
 * cannot be executed until a separate tool provider and permission rule are installed.
 */
export function describeSkillBundle(bundle: SkillBundle): string {
  const files = `${bundle.files.length} bundled file${bundle.files.length === 1 ? '' : 's'}`;
  const tools = `${bundle.toolDeclarations.length} declared tool${bundle.toolDeclarations.length === 1 ? '' : 's'}`;
  return `${files}; ${tools}; no tool authority granted.`;
}

export function describeSkillBundleProvenance(bundle: SkillBundle): string {
  if (bundle.provenance === 'local') return 'Local bundle · authored in IRIS';
  if (!bundle.source?.url) return 'Imported bundle · source not recorded';
  if (bundle.source.lastCheck === 'unavailable') return 'Imported bundle · source unavailable';
  if (bundle.source.lastCheck === 'changed' || bundle.source.lastCheck === 'moved') {
    return `Imported bundle · review ${bundle.source.lastCheck}`;
  }
  return bundle.source.lastCheck === 'unchanged'
    ? 'Imported bundle · source checked unchanged'
    : 'Imported bundle · source recorded, not checked';
}

export interface SkillDraft {
  name: string;
  summary: string;
  instructions: string;
  enabled: boolean;
}

export interface SkillRepository {
  list(): Promise<SkillDefinition[]>;
  get(id: string): Promise<SkillDefinition | null>;
  save(skill: SkillDefinition): Promise<void>;
  remove(id: string): Promise<void>;
}

export function cloneSkill(skill: SkillDefinition): SkillDefinition {
  return {
    ...skill,
    ...(skill.origin ? { origin: { ...skill.origin } } : {}),
    ...(skill.bundle ? { bundle: cloneSkillBundle(skill.bundle) } : {}),
  };
}

export function validateSkill(value: unknown): value is SkillDefinition {
  if (!value || typeof value !== 'object') return false;
  const skill = value as Partial<SkillDefinition>;
  return (
    skill.version === 1 &&
    typeof skill.id === 'string' &&
    Boolean(skill.id.trim()) &&
    typeof skill.name === 'string' &&
    Boolean(skill.name.trim()) &&
    typeof skill.summary === 'string' &&
    typeof skill.instructions === 'string' &&
    Boolean(skill.instructions.trim()) &&
    typeof skill.enabled === 'boolean' &&
    validateSkillBundle(skill.bundle) &&
    validateOrigin(skill.origin) &&
    typeof skill.createdAt === 'string' &&
    Boolean(skill.createdAt) &&
    typeof skill.updatedAt === 'string' &&
    Boolean(skill.updatedAt)
  );
}

function requireText(value: unknown, label: string, limit: number, required: boolean): string {
  if (typeof value !== 'string') throw new Error(`A skill ${label} must be text.`);
  const normalized = value.trim();
  if (required && !normalized) throw new Error(`A skill needs ${label}.`);
  if (normalized.length > limit) {
    throw new Error(
      `A skill ${label} is limited to ${limit} characters, but this one has ${normalized.length}.`,
    );
  }
  return normalized;
}

export function normalizeSkillDraft(draft: SkillDraft): SkillDraft {
  return {
    name: requireText(draft.name, 'name', skillNameLimit, true),
    summary: requireText(draft.summary, 'summary', skillSummaryLimit, false),
    instructions: requireText(draft.instructions, 'instructions', skillInstructionsLimit, true),
    enabled: Boolean(draft.enabled),
  };
}

export interface SkillTimestamps {
  createdAt: string;
  updatedAt: string;
}

export function createSkill(
  id: string,
  draft: SkillDraft,
  timestamps: SkillTimestamps,
  origin: SkillOrigin = { kind: 'local' },
): SkillDefinition {
  const normalized = normalizeSkillDraft(draft);
  const skillId = id.trim();
  if (!skillId) throw new Error('A skill needs an identifier.');
  return {
    version: 1,
    id: skillId,
    ...normalized,
    origin: { ...origin },
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  };
}

export function updateSkill(
  skill: SkillDefinition,
  draft: SkillDraft,
  updatedAt: string,
): SkillDefinition {
  const normalized = normalizeSkillDraft(draft);
  return { ...skill, ...normalized, updatedAt };
}

export interface SkillServiceOptions {
  createId?: () => string;
  now?: () => Date;
}

export class SkillService {
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly repository: SkillRepository,
    options: SkillServiceOptions = {},
  ) {
    this.createId = options.createId ?? (() => `skill-${crypto.randomUUID()}`);
    this.now = options.now ?? (() => new Date());
  }

  async list(): Promise<SkillDefinition[]> {
    return (await this.repository.list()).map(cloneSkill);
  }

  async create(
    draft: SkillDraft,
    origin: SkillOrigin = { kind: 'local' },
  ): Promise<SkillDefinition> {
    const timestamp = this.now().toISOString();
    const skill = createSkill(
      this.createId(),
      draft,
      { createdAt: timestamp, updatedAt: timestamp },
      origin,
    );
    await this.repository.save(skill);
    return cloneSkill(skill);
  }

  async update(id: string, draft: SkillDraft): Promise<SkillDefinition> {
    const existing = await this.repository.get(id);
    if (!existing) throw new Error(`Unknown skill: ${id}`);
    const skill = updateSkill(existing, draft, this.now().toISOString());
    await this.repository.save(skill);
    return cloneSkill(skill);
  }

  async setEnabled(id: string, enabled: boolean): Promise<SkillDefinition> {
    const existing = await this.repository.get(id);
    if (!existing) throw new Error(`Unknown skill: ${id}`);
    const skill: SkillDefinition = { ...existing, enabled, updatedAt: this.now().toISOString() };
    await this.repository.save(skill);
    return cloneSkill(skill);
  }

  async setBundle(id: string, bundle: SkillBundle | undefined): Promise<SkillDefinition> {
    const existing = await this.repository.get(id);
    if (!existing) throw new Error(`Unknown skill: ${id}`);
    if (bundle && !validateSkillBundle(bundle))
      throw new Error('Cannot persist an invalid skill bundle.');
    const skill: SkillDefinition = {
      ...existing,
      ...(bundle ? { bundle: cloneSkillBundle(bundle) } : {}),
      ...(!bundle ? { bundle: undefined } : {}),
      updatedAt: this.now().toISOString(),
    };
    await this.repository.save(skill);
    return cloneSkill(skill);
  }

  async recordImportedSourceCheck(
    id: string,
    check: Pick<ImportedSkillSourceCheck, 'status' | 'checkedAt'>,
  ): Promise<SkillDefinition> {
    const existing = await this.repository.get(id);
    if (!existing) throw new Error(`Unknown skill: ${id}`);
    const origin = skillOrigin(existing);
    if (origin.kind !== 'imported')
      throw new Error('Only imported skills have an external source.');
    const skill: SkillDefinition = {
      ...existing,
      origin: { ...origin, lastCheckedAt: check.checkedAt, lastCheck: check.status },
    };
    await this.repository.save(skill);
    return cloneSkill(skill);
  }

  async updateImportedFromSource(
    id: string,
    proposedText: string,
    checkedAt: string,
    sourceUrl?: string,
  ): Promise<SkillDefinition> {
    const existing = await this.repository.get(id);
    if (!existing) throw new Error(`Unknown skill: ${id}`);
    const skill = applyImportedSkillUpdate(
      existing,
      proposedText,
      this.now().toISOString(),
      checkedAt,
      sourceUrl,
    );
    await this.repository.save(skill);
    return cloneSkill(skill);
  }

  async remove(id: string): Promise<void> {
    await this.repository.remove(id);
  }
}

export interface AgentSkillResolution {
  active: SkillDefinition[];
  disabled: SkillDefinition[];
  missingIds: string[];
}

export function resolveAgentSkills(
  agent: Pick<AgentDefinition, 'skillIds'>,
  skills: readonly SkillDefinition[],
): AgentSkillResolution {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const active: SkillDefinition[] = [];
  const disabled: SkillDefinition[] = [];
  const missingIds: string[] = [];
  for (const skillId of agent.skillIds) {
    const skill = byId.get(skillId);
    if (!skill) {
      missingIds.push(skillId);
      continue;
    }
    if (skill.enabled) active.push(cloneSkill(skill));
    else disabled.push(cloneSkill(skill));
  }
  return { active, disabled, missingIds };
}

export function describeAgentSkills(resolution: AgentSkillResolution): string {
  const parts: string[] = [];
  if (resolution.active.length) {
    parts.push(
      `${resolution.active.length} enabled ${resolution.active.length === 1 ? 'skill was' : 'skills were'} injected for this turn.`,
    );
  } else {
    parts.push('No enabled skill is assigned to this agent.');
  }
  if (resolution.disabled.length) {
    parts.push(
      `${resolution.disabled.length} assigned ${resolution.disabled.length === 1 ? 'skill is disabled and was' : 'skills are disabled and were'} not injected.`,
    );
  }
  if (resolution.missingIds.length) {
    parts.push(
      `${resolution.missingIds.length} assigned ${resolution.missingIds.length === 1 ? 'skill no longer exists' : 'skills no longer exist'}.`,
    );
  }
  return parts.join(' ');
}

export interface SkillCatalogEntry {
  slug: string;
  name: string;
  description: string;
  category: string;
  icon?: string;
  tags: string[];
  sourceUrl?: string;
  installCommand?: string;
  importCount: number;
}

export interface SkillCatalogPage {
  entries: SkillCatalogEntry[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface SkillCatalogQuery {
  query?: string;
  category?: string;
  page?: number;
  limit?: number;
}

export interface SkillCatalogDescriptor {
  id: string;
  name: string;
  homeUrl: string;
}

export interface SkillCatalogSource {
  descriptor(): SkillCatalogDescriptor;
  categories(): readonly string[];
  browse(query: SkillCatalogQuery): Promise<SkillCatalogPage>;
  /** Returns the real instruction body for one catalog entry and its provenance, or null. */
  instructions(entry: SkillCatalogEntry): Promise<SkillInstructions | null>;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boundedCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Catalog payloads come from a third-party HTTP service, so every field is treated as untrusted
 * and an entry that cannot be read is dropped rather than partially trusted.
 */
export function parseSkillCatalogEntry(value: unknown): SkillCatalogEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const slug = optionalText(entry.slug);
  const name = optionalText(entry.name);
  if (!slug || !name) return null;
  return {
    slug,
    name,
    description: optionalText(entry.description) ?? '',
    category: optionalText(entry.category) ?? 'uncategorised',
    ...(optionalText(entry.icon) ? { icon: optionalText(entry.icon) } : {}),
    tags: Array.isArray(entry.tags)
      ? entry.tags.flatMap((tag) => {
          const normalized = optionalText(tag);
          return normalized ? [normalized] : [];
        })
      : [],
    ...(optionalText(entry.sourceUrl) ? { sourceUrl: optionalText(entry.sourceUrl) } : {}),
    ...(optionalText(entry.installCommand)
      ? { installCommand: optionalText(entry.installCommand) }
      : {}),
    importCount: boundedCount(entry.importCount),
  };
}

export function parseSkillCatalogPage(value: unknown, requestedLimit: number): SkillCatalogPage {
  if (!value || typeof value !== 'object') {
    throw new Error('The skill catalog returned an unreadable response.');
  }
  const payload = value as Record<string, unknown>;
  if (!Array.isArray(payload.data)) {
    throw new Error('The skill catalog returned no result list.');
  }
  const entries = payload.data.flatMap((item) => {
    const entry = parseSkillCatalogEntry(item);
    return entry ? [entry] : [];
  });
  const pagination = (
    payload.pagination && typeof payload.pagination === 'object' ? payload.pagination : {}
  ) as Record<string, unknown>;
  const limit = boundedCount(pagination.limit) || requestedLimit;
  const total = boundedCount(pagination.total);
  return {
    entries,
    page: boundedCount(pagination.page) || 1,
    limit,
    total,
    totalPages: boundedCount(pagination.totalPages) || (limit > 0 ? Math.ceil(total / limit) : 1),
  };
}

/**
 * Where an instruction body actually came from. The directory usually carries none, so the skill's
 * own source repository is the real home of the content.
 */
export interface SkillInstructions {
  body: string;
  origin: 'catalog' | 'repository';
  /** The exact document the body was read from, when it came from a repository. */
  url?: string;
}

/**
 * Turns a catalog `sourceUrl` into the raw document addresses that may hold the skill. Both the
 * `tree` (directory) and `blob` (file) forms appear in the directory, and a bare repository link
 * needs its default branch guessed, so several candidates are returned in priority order.
 */
export function skillDocumentCandidates(sourceUrl: string, slug?: string): string[] {
  let url: URL;
  try {
    url = new URL(sourceUrl.trim());
  } catch {
    return [];
  }
  if (url.hostname !== 'github.com') return [];
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return [];
  const [owner, repo, kind, branch, ...rest] = segments;
  const raw = (ref: string, path: string[]) =>
    `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path.join('/')}`;

  if (kind === 'blob' && branch && rest.length) {
    // A direct file link is already the document.
    return [raw(branch, rest)];
  }
  if (kind === 'tree' && branch) {
    return ['SKILL.md', 'skill.md', 'README.md'].map((file) => raw(branch, [...rest, file]));
  }
  const repositoryPaths = [
    ['SKILL.md'],
    ['skill.md'],
    ...(slug?.trim()
      ? [
          ['skills', slug.trim(), 'SKILL.md'],
          [slug.trim(), 'SKILL.md'],
        ]
      : []),
  ];
  return ['main', 'master'].flatMap((ref) => repositoryPaths.map((path) => raw(ref, path)));
}

export interface SkillDocument {
  name?: string;
  description?: string;
  body: string;
}

/**
 * A skill document is markdown with optional YAML front matter. Only the body is instruction text;
 * the front matter is metadata that would otherwise be injected as if it were guidance.
 */
export function parseSkillDocument(text: string): SkillDocument {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { body: text.trim() };
  const frontMatter = match[1] ?? '';
  const field = (key: string): string | undefined => {
    const found = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(frontMatter);
    const value = found?.[1]?.trim().replace(/^["']|["']$/g, '');
    return value || undefined;
  };
  return {
    ...(field('name') ? { name: field('name') } : {}),
    ...(field('description') ? { description: field('description') } : {}),
    body: (match[2] ?? '').trim(),
  };
}

export interface SkillImportInput {
  entry: SkillCatalogEntry;
  instructions: string;
  /** Where the body came from, so an imported skill records its true source. */
  instructionsUrl?: string;
  catalog: SkillCatalogDescriptor;
  importedAt: string;
}

/**
 * Most directory entries carry no instruction body at all: the catalog simply repeats the entry's
 * own description in the instruction field. Importing that would inject a claim about a capability
 * rather than guidance for one, so it is treated as an empty body, not a short one.
 */
export function catalogInstructionsAreDescriptionOnly(
  entry: SkillCatalogEntry,
  instructions: string,
): boolean {
  const body = instructions.trim();
  const description = entry.description.trim();
  return Boolean(body) && Boolean(description) && body === description;
}

/**
 * A summary is descriptive metadata, so an over-long catalog description is shortened. Instructions
 * decide how the agent behaves, so an over-long body is refused by normalizeSkillDraft instead of
 * being silently cut in half.
 */
export function skillDraftFromCatalog(entry: SkillCatalogEntry, instructions: string): SkillDraft {
  if (!instructions.trim()) {
    throw new Error(
      `“${entry.name}” has no instruction text in the catalog, so there is nothing to import.`,
    );
  }
  if (catalogInstructionsAreDescriptionOnly(entry, instructions)) {
    throw new Error(
      `“${entry.name}” has no instructions in the catalog — its instruction field only repeats its own description. Importing it would tell the agent it has a capability without telling it how to use one.`,
    );
  }
  const description = entry.description.trim();
  return normalizeSkillDraft({
    name: entry.name,
    summary:
      description.length > skillSummaryLimit
        ? `${description.slice(0, skillSummaryLimit - 1).trimEnd()}…`
        : description,
    instructions,
    enabled: true,
  });
}

export function importedSkillOrigin(input: SkillImportInput): SkillOrigin {
  const sourceUrl = input.instructionsUrl ?? input.entry.sourceUrl;
  return {
    kind: 'imported',
    catalogId: input.catalog.id,
    catalogName: input.catalog.name,
    slug: input.entry.slug,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(input.entry.sourceUrl && input.entry.sourceUrl !== sourceUrl
      ? { repositoryUrl: input.entry.sourceUrl }
      : {}),
    importedAt: input.importedAt,
    sourceFingerprint: fingerprintSkillText(input.instructions),
  };
}

/** A small deterministic fingerprint that works in both the browser and native runtimes. */
export function fingerprintSkillText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export type ImportedSkillSourceStatus = 'unchanged' | 'changed' | 'unavailable' | 'moved';

export interface ImportedSkillSourceCheck {
  status: ImportedSkillSourceStatus;
  previousText: string;
  proposedText?: string;
  sourceUrl?: string;
  checkedAt: string;
}

export function diffSkillInstructions(previous: string, proposed: string): string {
  if (previous === proposed) return '  (no instruction changes)';
  const before = previous.split(/\r?\n/);
  const after = proposed.split(/\r?\n/);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1;
  const lines = before.slice(prefix, before.length - suffix).map((line) => `- ${line}`);
  lines.push(...after.slice(prefix, after.length - suffix).map((line) => `+ ${line}`));
  if (prefix) lines.unshift('  … unchanged above');
  if (suffix) lines.push('  … unchanged below');
  return lines.join('\n');
}

export function sourceCheckFor(
  skill: SkillDefinition,
  proposedText: string | null,
  checkedAt: string,
  sourceUrl?: string,
  statusOverride?: 'unavailable' | 'moved',
): ImportedSkillSourceCheck {
  const origin = skillOrigin(skill);
  if (origin.kind !== 'imported') throw new Error('Only imported skills have an external source.');
  if (statusOverride) {
    return {
      status: statusOverride,
      previousText: skill.instructions,
      checkedAt,
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  }
  if (proposedText === null) {
    return {
      status: 'unavailable',
      previousText: skill.instructions,
      checkedAt,
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  }
  return {
    status:
      fingerprintSkillText(proposedText) ===
      (origin.sourceFingerprint ?? fingerprintSkillText(skill.instructions))
        ? 'unchanged'
        : 'changed',
    previousText: skill.instructions,
    proposedText,
    checkedAt,
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

export function applyImportedSkillUpdate(
  skill: SkillDefinition,
  proposedText: string,
  updatedAt: string,
  checkedAt: string,
  sourceUrl?: string,
): SkillDefinition {
  const origin = skillOrigin(skill);
  if (origin.kind !== 'imported')
    throw new Error('Only imported skills can be updated from a source.');
  const normalized = normalizeSkillDraft({
    name: skill.name,
    summary: skill.summary,
    instructions: proposedText,
    enabled: skill.enabled,
  });
  return {
    ...skill,
    ...normalized,
    updatedAt,
    origin: {
      ...origin,
      ...(sourceUrl ? { sourceUrl } : {}),
      sourceFingerprint: fingerprintSkillText(normalized.instructions),
      lastCheckedAt: checkedAt,
      lastCheck: 'unchanged',
    },
  };
}

export function findImportedSkill(
  skills: readonly SkillDefinition[],
  catalogId: string,
  slug: string,
): SkillDefinition | null {
  return (
    skills.find(
      (skill) =>
        skill.origin?.kind === 'imported' &&
        skill.origin.catalogId === catalogId &&
        skill.origin.slug === slug,
    ) ?? null
  );
}

export function renderSkill(skill: SkillDefinition): string {
  const summary = skill.summary ? `${skill.summary}\n\n` : '';
  return `## ${skill.name}\n\n${summary}${skill.instructions}`;
}
