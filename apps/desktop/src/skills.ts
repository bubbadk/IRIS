import {
  SkillService,
  sourceCheckFor,
  type ImportedSkillSourceCheck,
  findImportedSkill,
  importedSkillOrigin,
  skillDraftFromCatalog,
  type SkillCatalogEntry,
  type SkillDefinition,
  type SkillBundle,
  type SkillInstructions,
  type SkillDraft,
} from '@iris/skills';
import { skillRepository } from './persistence';
import { skillCatalog } from './skillCatalog';
import { syncBundledSkillCapabilityProviders } from './skillCapabilities';

export const skillService = new SkillService(skillRepository);

const listeners = new Set<() => void>();

export function subscribeSkills(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifySkillsChanged(): void {
  listeners.forEach((listener) => listener());
}

export async function listSkills(): Promise<SkillDefinition[]> {
  const skills = await skillService.list();
  syncBundledSkillCapabilityProviders(skills);
  return skills;
}

export async function createSkillDefinition(draft: SkillDraft): Promise<SkillDefinition> {
  const skill = await skillService.create(draft);
  notifySkillsChanged();
  return skill;
}

export async function updateSkillDefinition(
  id: string,
  draft: SkillDraft,
): Promise<SkillDefinition> {
  const skill = await skillService.update(id, draft);
  notifySkillsChanged();
  return skill;
}

export async function setSkillBundleDefinition(
  id: string,
  bundle: SkillBundle | undefined,
): Promise<SkillDefinition> {
  const skill = await skillService.setBundle(id, bundle);
  notifySkillsChanged();
  return skill;
}

export async function setSkillEnabled(id: string, enabled: boolean): Promise<SkillDefinition> {
  const skill = await skillService.setEnabled(id, enabled);
  notifySkillsChanged();
  return skill;
}

export async function removeSkillDefinition(id: string): Promise<void> {
  await skillService.remove(id);
  notifySkillsChanged();
}

export async function checkImportedSkillSource(id: string): Promise<ImportedSkillSourceCheck> {
  const skill = await skillService.list().then((skills) => skills.find((item) => item.id === id));
  if (!skill) throw new Error(`Unknown skill: ${id}`);
  const origin = skill.origin;
  if (!origin || origin.kind !== 'imported') {
    throw new Error('Only imported skills can be checked against an external source.');
  }
  const checkedAt = new Date().toISOString();
  const read = await skillCatalog.readImportedSource(origin);
  const check = sourceCheckFor(
    skill,
    read.text,
    checkedAt,
    read.url,
    read.moved ? (read.text ? 'moved' : 'unavailable') : undefined,
  );
  await skillService.recordImportedSourceCheck(id, check);
  notifySkillsChanged();
  return check;
}

export async function updateImportedSkillFromSource(
  id: string,
  proposedText: string,
  checkedAt: string,
  sourceUrl?: string,
): Promise<SkillDefinition> {
  const skill = await skillService.updateImportedFromSource(id, proposedText, checkedAt, sourceUrl);
  notifySkillsChanged();
  return skill;
}

/** Resolves the real instruction body so the user can read it, and where it was read from. */
export async function previewCatalogSkill(entry: SkillCatalogEntry): Promise<SkillInstructions> {
  const instructions = await skillCatalog.instructions(entry);
  if (!instructions?.body.trim()) {
    throw new Error(
      `“${entry.name}” has no instructions in ${skillCatalog.descriptor().name} and none in its source repository, so there is nothing to import.`,
    );
  }
  return instructions;
}

export async function importCatalogSkill(
  entry: SkillCatalogEntry,
  instructions: SkillInstructions,
): Promise<SkillDefinition> {
  const existing = findImportedSkill(
    await skillService.list(),
    skillCatalog.descriptor().id,
    entry.slug,
  );
  if (existing) {
    throw new Error(`“${entry.name}” is already imported as a local skill.`);
  }
  const skill = await skillService.create(
    skillDraftFromCatalog(entry, instructions.body),
    importedSkillOrigin({
      entry,
      instructions: instructions.body,
      ...(instructions.url ? { instructionsUrl: instructions.url } : {}),
      catalog: skillCatalog.descriptor(),
      importedAt: new Date().toISOString(),
    }),
  );
  notifySkillsChanged();
  return skill;
}
