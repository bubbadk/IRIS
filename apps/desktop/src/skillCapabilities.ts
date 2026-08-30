import type {
  SkillBundleCapabilityProvider,
  SkillDefinition,
  SkillBundleToolDeclaration,
} from '@iris/skills';
import { toolRegistry } from './tooling';

/** Built-in, read-only capability for inspecting files shipped with the same skill bundle. */
export const bundledSkillReadFileToolId = 'skill.bundle.read_file';
/** Built-in, read-only capability for listing files shipped with the same skill bundle. */
export const bundledSkillListFilesToolId = 'skill.bundle.list_files';
/** Built-in, read-only capability for searching text in files shipped with the same skill bundle. */
export const bundledSkillSearchFilesToolId = 'skill.bundle.search_files';
/** Built-in, read-only capability for finding files shipped inside the same skill bundle. */
export const bundledSkillFindFilesToolId = 'skill.bundle.find_files';
export const bundledSkillSummaryToolId = 'skill.bundle.summary';
/** Built-in, read-only capability for parsing a JSON file shipped inside the same skill bundle. */
export const bundledSkillReadJsonToolId = 'skill.bundle.read_json';
/** Built-in, read-only capability for parsing a CSV file shipped inside the same skill bundle. */
export const bundledSkillReadCsvToolId = 'skill.bundle.read_csv';

const builtInBundledCapabilityIds = new Set([
  bundledSkillReadFileToolId,
  bundledSkillListFilesToolId,
  bundledSkillSearchFilesToolId,
  bundledSkillFindFilesToolId,
  bundledSkillSummaryToolId,
  bundledSkillReadJsonToolId,
  bundledSkillReadCsvToolId,
]);

const bundledSearchQueryLimit = 200;
const bundledSearchMatchLimit = 50;
const bundledSearchSnippetLimit = 240;
const bundledFindQueryLimit = 200;
const bundledFindMatchLimit = 100;
const bundledJsonOutputLimit = 64 * 1024;
const bundledCsvRowLimit = 2_000;
const bundledCsvColumnLimit = 100;
const bundledCsvFieldLimit = 32 * 1024;
const bundledCsvOutputLimit = 64 * 1024;

export type SkillCapabilityStatus =
  | { status: 'unavailable'; reason: 'provider-not-registered' }
  | { status: 'registered'; toolId: string };

const providers = new Map<string, SkillBundleCapabilityProvider>();
const currentSkills = new Map<string, SkillDefinition>();

function providerKey(skillId: string, toolId: string): string {
  return `${skillId}:${toolId}`;
}

function declarationFor(skill: SkillDefinition, toolId: string): SkillBundleToolDeclaration {
  const declaration = skill.bundle?.toolDeclarations.find((tool) => tool.id === toolId);
  if (!declaration) {
    throw new Error(`Skill ${skill.id} does not declare capability ${toolId}.`);
  }
  return declaration;
}

function assertEmptyBundleInput(input: unknown, message: string): void {
  if (
    input !== undefined &&
    input !== null &&
    (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 0)
  ) {
    throw new Error(message);
  }
}

function parseBundledCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;

  const pushField = () => {
    if (field.length > bundledCsvFieldLimit) {
      throw new Error(`Bundled CSV fields cannot exceed ${bundledCsvFieldLimit} characters.`);
    }
    row.push(field);
    field = '';
    if (row.length > bundledCsvColumnLimit) {
      throw new Error(`Bundled CSV rows cannot exceed ${bundledCsvColumnLimit} columns.`);
    }
  };
  const pushRow = () => {
    // A final newline does not create an additional empty record.
    if (row.length > 0 || field.length > 0) {
      pushField();
      rows.push(row);
      row = [];
      if (rows.length > bundledCsvRowLimit) {
        throw new Error(`Bundled CSV files cannot exceed ${bundledCsvRowLimit} rows.`);
      }
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (afterQuote) {
      if (character === delimiter) {
        pushField();
        afterQuote = false;
      } else if (character === '\n') {
        pushRow();
        afterQuote = false;
      } else if (character === '\r' && text[index + 1] === '\n') {
        pushRow();
        index += 1;
        afterQuote = false;
      } else {
        throw new Error('Bundled CSV contains characters after a closing quote.');
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      pushField();
    } else if (character === '\n') {
      pushRow();
    } else if (character === '\r' && text[index + 1] === '\n') {
      pushRow();
      index += 1;
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('Bundled CSV contains an unterminated quoted field.');
  if (afterQuote || row.length > 0 || field.length > 0) pushRow();
  return rows;
}

/** Registers one host-owned implementation. Registration never creates assignment or permission. */
export function registerSkillCapabilityProvider(
  skill: SkillDefinition,
  provider: SkillBundleCapabilityProvider,
): SkillCapabilityStatus {
  if (!skill.bundle) throw new Error(`Skill ${skill.id} has no bundled capabilities.`);
  if (provider.skillId !== skill.id)
    throw new Error('Capability provider belongs to another skill.');
  const declaration = declarationFor(skill, provider.toolId);
  const key = providerKey(skill.id, declaration.id);
  if (providers.has(key))
    throw new Error(`Capability provider already registered: ${declaration.id}`);
  if (toolRegistry.get(declaration.id)) {
    throw new Error(`A tool is already registered with capability id: ${declaration.id}`);
  }
  providers.set(key, provider);
  toolRegistry.register({
    id: declaration.id,
    name: declaration.name,
    description: declaration.description,
    risk: declaration.risk,
    providerName: `skill_${declaration.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    ...(declaration.inputSchema ? { inputSchema: structuredClone(declaration.inputSchema) } : {}),
    run: (input, context) => provider.run(input, context),
  });
  return { status: 'registered', toolId: declaration.id };
}

export function unregisterSkillCapabilityProvider(skillId: string, toolId: string): boolean {
  const key = providerKey(skillId, toolId);
  const removed = providers.delete(key);
  if (removed) toolRegistry.unregister(toolId);
  return removed;
}

export function skillCapabilityStatus(
  skill: SkillDefinition,
  toolId: string,
): SkillCapabilityStatus {
  return providers.has(providerKey(skill.id, toolId))
    ? { status: 'registered', toolId }
    : { status: 'unavailable', reason: 'provider-not-registered' };
}

export function clearSkillCapabilityProviders(): void {
  for (const provider of providers.values()) toolRegistry.unregister(provider.toolId);
  providers.clear();
  currentSkills.clear();
}

/**
 * Installs the deliberately narrow built-in providers currently supported for bundles.
 * The provider reads persisted bundle data only; it never reaches the host filesystem.
 */
export function syncBundledSkillCapabilityProviders(skills: SkillDefinition[]): void {
  const supported = new Set<string>();
  for (const skill of skills) {
    const declarations = skill.bundle?.toolDeclarations.filter(
      (tool) =>
        builtInBundledCapabilityIds.has(tool.id) &&
        tool.risk === 'read',
    );
    if (!declarations?.length) continue;
    currentSkills.set(skill.id, skill);
    for (const declaration of declarations) {
      supported.add(providerKey(skill.id, declaration.id));
      const key = providerKey(skill.id, declaration.id);
      if (providers.has(key)) continue;
      registerSkillCapabilityProvider(skill, {
        skillId: skill.id,
        toolId: declaration.id,
        async run(input) {
          const currentSkill = currentSkills.get(skill.id) ?? skill;
          if (declaration.id === bundledSkillListFilesToolId) {
            assertEmptyBundleInput(input, 'Bundled file listings accept only an empty object.');
            return {
              files:
                currentSkill.bundle?.files.map((file) => ({
                  path: file.path,
                  bytes: new TextEncoder().encode(file.content).byteLength,
                })) ?? [],
            };
          }
          if (declaration.id === bundledSkillSummaryToolId) {
            assertEmptyBundleInput(input, 'Bundled skill summaries accept only an empty object.');
            const files = currentSkill.bundle?.files ?? [];
            return {
              name: currentSkill.name,
              summary: currentSkill.summary,
              files: files.length,
              bytes: files.reduce(
                (total, file) => total + new TextEncoder().encode(file.content).byteLength,
                0,
              ),
            };
          }
          if (declaration.id === bundledSkillFindFilesToolId) {
            if (!input || typeof input !== 'object' || Array.isArray(input)) {
              throw new Error('Bundled file searches require an object with a query.');
            }
            const value = input as { query?: unknown };
            if (
              Object.keys(value).some((key) => key !== 'query') ||
              typeof value.query !== 'string' ||
              !value.query.trim() ||
              value.query !== value.query.trim() ||
              value.query.length > bundledFindQueryLimit
            ) {
              throw new Error(
                `Bundled file searches require a trimmed query of at most ${bundledFindQueryLimit} characters.`,
              );
            }
            const query = value.query.toLocaleLowerCase();
            const files = currentSkill.bundle?.files ?? [];
            const matches = files
              .filter((file) => file.path.toLocaleLowerCase().includes(query))
              .slice(0, bundledFindMatchLimit)
              .map((file) => ({
                path: file.path,
                bytes: new TextEncoder().encode(file.content).byteLength,
              }));
            return {
              query: value.query,
              matches,
              truncated:
                files.filter((file) => file.path.toLocaleLowerCase().includes(query)).length >
                bundledFindMatchLimit,
            };
          }
          if (declaration.id === bundledSkillReadJsonToolId) {
            if (!input || typeof input !== 'object' || Array.isArray(input)) {
              throw new Error('Bundled JSON reads require an object with a path.');
            }
            const value = input as Record<string, unknown>;
            const path = value.path;
            if (
              Object.keys(value).some((key) => key !== 'path') ||
              typeof path !== 'string' ||
              !path.trim() ||
              path !== path.trim()
            ) {
              throw new Error('Bundled JSON reads require an exact relative path.');
            }
            const file = currentSkill.bundle?.files.find((candidate) => candidate.path === path);
            if (!file) throw new Error(`No bundled file exists at ${path}.`);
            let parsed: unknown;
            try {
              parsed = JSON.parse(file.content) as unknown;
            } catch {
              throw new Error(`Bundled file at ${path} does not contain valid JSON.`);
            }
            const serialized = JSON.stringify(parsed);
            if (serialized.length > bundledJsonOutputLimit) {
              throw new Error(
                `Bundled JSON at ${path} exceeds the ${bundledJsonOutputLimit}-character output limit.`,
              );
            }
            return { path: file.path, value: parsed };
          }
          if (declaration.id === bundledSkillReadCsvToolId) {
            if (!input || typeof input !== 'object' || Array.isArray(input)) {
              throw new Error('Bundled CSV reads require an object with a path.');
            }
            const value = input as { path?: unknown; delimiter?: unknown };
            const path = value.path;
            const delimiter = value.delimiter ?? ',';
            if (
              Object.keys(value).some((key) => key !== 'path' && key !== 'delimiter') ||
              typeof path !== 'string' ||
              !path.trim() ||
              path !== path.trim() ||
              typeof delimiter !== 'string' ||
              delimiter.length !== 1 ||
              delimiter === '"' ||
              delimiter === '\n' ||
              delimiter === '\r'
            ) {
              throw new Error(
                'Bundled CSV reads require an exact path and one-character delimiter.',
              );
            }
            const file = currentSkill.bundle?.files.find((candidate) => candidate.path === path);
            if (!file) throw new Error(`No bundled file exists at ${path}.`);
            const parsed = parseBundledCsv(file.content, delimiter);
            const columns = parsed[0] ?? [];
            const rows = parsed.slice(1);
            const output = { path: file.path, columns, rows, truncated: false };
            if (JSON.stringify(output).length > bundledCsvOutputLimit) {
              throw new Error(
                `Bundled CSV output exceeds the ${bundledCsvOutputLimit}-character limit.`,
              );
            }
            return output;
          }
          if (declaration.id === bundledSkillSearchFilesToolId) {
            if (!input || typeof input !== 'object' || Array.isArray(input)) {
              throw new Error('Bundled file searches require an object with a query.');
            }
            const value = input as { query?: unknown; path?: unknown };
            if (
              Object.keys(value).some((key) => key !== 'query' && key !== 'path') ||
              typeof value.query !== 'string' ||
              !value.query.trim() ||
              value.query !== value.query.trim() ||
              value.query.length > bundledSearchQueryLimit
            ) {
              throw new Error(
                `Bundled file searches require a trimmed query of at most ${bundledSearchQueryLimit} characters.`,
              );
            }
            if (
              value.path !== undefined &&
              (typeof value.path !== 'string' ||
                !value.path.trim() ||
                value.path !== value.path.trim())
            ) {
              throw new Error(
                'Bundled file searches require an exact relative path when provided.',
              );
            }
            const query = value.query.toLocaleLowerCase();
            const files = currentSkill.bundle?.files ?? [];
            const candidates = value.path
              ? files.filter((file) => file.path === value.path)
              : files;
            if (value.path && candidates.length === 0) {
              throw new Error(`No bundled file exists at ${value.path}.`);
            }
            const matches: Array<{ path: string; line: number; text: string }> = [];
            for (const file of candidates) {
              const lines = file.content.split('\n');
              for (const [index, line] of lines.entries()) {
                if (!line.toLocaleLowerCase().includes(query)) continue;
                matches.push({
                  path: file.path,
                  line: index + 1,
                  text: line.slice(0, bundledSearchSnippetLimit),
                });
                if (matches.length >= bundledSearchMatchLimit) {
                  return { query: value.query, matches, truncated: true };
                }
              }
            }
            return { query: value.query, matches, truncated: false };
          }
          if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw new Error('Bundled file reads require an object with a path.');
          }
          const path = (input as { path?: unknown }).path;
          if (typeof path !== 'string' || !path.trim() || path !== path.trim()) {
            throw new Error('Bundled file reads require an exact relative path.');
          }
          const file = currentSkill.bundle?.files.find((candidate) => candidate.path === path);
          if (!file) throw new Error(`No bundled file exists at ${path}.`);
          return { path: file.path, content: file.content };
        },
      });
    }
  }

  for (const [key, provider] of providers) {
    if (builtInBundledCapabilityIds.has(provider.toolId) && !supported.has(key)) {
      unregisterSkillCapabilityProvider(provider.skillId, provider.toolId);
      if (![...providers.values()].every((candidate) => candidate.skillId !== provider.skillId)) {
        continue;
      }
      currentSkills.delete(provider.skillId);
    }
  }
}
