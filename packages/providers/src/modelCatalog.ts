/**
 * The single authoritative model catalog: capability classification and default selection.
 *
 * IRIS previously decided "which model does this provider default to?" by taking the first entry
 * of an alphabetically sorted id list, and several modules each kept their own hardcoded list of
 * "valid" model names. Both are wrong in the same way: they treat a model's *name* and its position
 * in a list as capability evidence. `chatgpt-image-latest` sorts before every GPT chat model, and a
 * hardcoded allow-list silently hides models that did not exist when it was written.
 *
 * This module is the one place that answers:
 *   - is this model usable for conversational chat?
 *   - is it a vision-capable chat model?
 *   - is it an image generation model?
 *   - is it an embedding model?
 *   - is it deprecated / experimental?
 *   - which model should a provider default to?
 *
 * Evidence order (documented policy, see `classifyModel`):
 *   1. `models.dev` metadata, when the provider directory supplied it: `modalities.input`,
 *      `modalities.output`, `reasoning`, `tool_call`, `status`, `experimental`, `release_date`.
 *   2. A conservative identifier heuristic, used only where the metadata cannot answer:
 *      - embedding models carry no distinguishing modality upstream (their `modalities.output` is
 *        plain `text`), so the documented embedding pattern is the only available signal;
 *      - a provider that only exposes a live `/models` list (or a built-in catalog entry with no
 *        metadata) has no metadata at all, so identifier heuristics decide default eligibility.
 *   3. Unknown. A model with neither metadata nor a recognized identifier is treated as an ordinary
 *      chat-capable model rather than blocked — a new model must not disappear because this code
 *      predates it. `chatSelectable` therefore defaults to true unless something positively
 *      excludes the model.
 *
 * Unknown models are never dropped from the catalog. They are shown, and only *default* eligibility
 * is affected by conservative heuristics, so a user can always pick a model IRIS would not
 * have picked on its own.
 */
import type { Capability } from '@iris/core';

/** Capabilities IRIS can classify from a provider directory record. */
export type ModelCapability =
  | 'chat'
  | 'reasoning'
  | 'vision-input'
  | 'image-generation'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'embedding'
  | 'tools';

/** Controlled state used when a provider has no chat-compatible model at all. */
export const NO_COMPATIBLE_CHAT_MODEL = 'no compatible chat model';

/** Raw provider-directory model record. Every field is optional and untrusted. */
export interface ModelMetadataRecord {
  id?: unknown;
  name?: unknown;
  family?: unknown;
  description?: unknown;
  reasoning?: unknown;
  tool_call?: unknown;
  attachment?: unknown;
  status?: unknown;
  experimental?: unknown;
  release_date?: unknown;
  modalities?: unknown;
}

/** Normalized, typed metadata for one catalog model. */
export interface ModelCatalogMetadata {
  id: string;
  name?: string;
  family?: string;
  description?: string;
  reasoning: boolean;
  toolCall: boolean;
  attachment: boolean;
  deprecated: boolean;
  experimental: boolean;
  releaseDate?: string;
  inputModalities: string[];
  outputModalities: string[];
  /**
   * True when the upstream record actually carried a modality block. Distinguishes "the directory
   * says this model emits only text" from "the directory said nothing at all", which is exactly the
   * difference between a metadata-driven decision and a conservative identifier fallback.
   */
  hasModalityMetadata: boolean;
}

/** One catalog model: an id plus whatever metadata is known about it. */
export interface CatalogModel {
  id: string;
  metadata?: ModelCatalogMetadata;
}

export interface ModelClassification {
  id: string;
  metadata: ModelCatalogMetadata | null;
  capabilities: ModelCapability[];
  /** Usable for conversational text generation (a chat default may be chosen from these). */
  chatSelectable: boolean;
  /** Usable for conversational text generation with image input. */
  visionChatSelectable: boolean;
  /** Usable as an image generation target. */
  imageSelectable: boolean;
  embedding: boolean;
  /** Eligible to become a provider default (chat selectable and not deprecated). */
  defaultEligible: boolean;
  /** Human-readable reason when `chatSelectable` is false. */
  reason?: string;
}

/**
 * Documented conservative identifier pattern for embedding models. `models.dev` publishes no
 * embedding output modality — `text-embedding-3-small` and `gemini-embedding-001` both report
 * `modalities.output: ["text"]` — so an identifier heuristic is the only available signal. The
 * pattern covers the families IRIS has actually observed and never matches a plain chat model.
 */
export const embeddingModelPattern =
  /(embed|bge[-_]|gte[-_]|(^|[-_/])e5[-_]|nomic|mxbai|arctic-embed|minilm|jina|voyage|sfr-embedding|instructor)/i;

/**
 * Documented conservative identifier pattern for recognized specialized-output families. It is
 * consulted only when the provider directory has no metadata for the model. A vision-capable *chat*
 * model is deliberately not matched: "vision" is an input capability, not evidence of a
 * non-conversational model.
 */
const specializedIdentifierPattern =
  /(whisper|tts|text-to-speech|speech-synthesis|realtime|audio-preview|dall-e|stable-diffusion|sdxl|(^|[-_/])flux([-_/]|$)|image|vision-encoder|moderation|rerank|(^|[-_/])clip([-_/]|$))/i;

/** Identifier-only image-generation families, for catalogs that carry no metadata at all. */
const imageIdentifierPattern =
  /(dall-e|stable-diffusion|sdxl|(^|[-_/])flux([-_/]|$)|image|imagen|(^|[-_/])clip([-_/]|$))/i;

/** Modalities that mark a model as a specialized generator rather than a conversational model. */
const specializedOutputModalities: readonly string[] = ['image', 'audio', 'video', 'pdf'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseModelMetadata(
  id: string,
  record: ModelMetadataRecord | undefined,
): ModelCatalogMetadata {
  const stringField = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const modalityList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
          .map((item) => item.trim().toLowerCase())
      : [];
  const modalities = isRecord(record?.modalities)
    ? (record!.modalities as { input?: unknown; output?: unknown })
    : undefined;
  const status = stringField(record?.status)?.toLowerCase();
  const experimental = record?.experimental;
  return {
    id,
    name: stringField(record?.name),
    family: stringField(record?.family),
    description: stringField(record?.description),
    reasoning: record?.reasoning === true,
    toolCall: record?.tool_call === true,
    attachment: record?.attachment === true,
    deprecated: status === 'deprecated' || status === 'retired' || status === 'removed',
    experimental: experimental === true || isRecord(experimental),
    releaseDate: stringField(record?.release_date),
    inputModalities: modalityList(modalities?.input),
    outputModalities: modalityList(modalities?.output),
    hasModalityMetadata: modalities !== undefined,
  };
}

/**
 * Classifies one catalog model. See the module header for the evidence order; the two rules that
 * keep M-27 from coming back are:
 *   - a model whose output includes a specialized generation modality (image/audio/video/pdf) is
 *     only chat-capable when the directory also says it handles tool calls — an image generator that
 *     emits a caption alongside the picture is not a conversational model;
 *   - embedding detection never depends on a model *list* position, only on metadata or the
 *     documented identifier pattern.
 */
export function classifyModel(model: CatalogModel): ModelClassification {
  const metadata = model.metadata ?? null;
  const id = model.id;
  const embeddingByIdentifier = embeddingModelPattern.test(id);
  const embeddingByMetadata =
    metadata !== null && (metadata.outputModalities.includes('embedding') || embeddingByIdentifier);
  const embedding = embeddingByMetadata || (metadata === null && embeddingByIdentifier);

  const declaresTextOutput = metadata !== null && metadata.outputModalities.includes('text');
  const declaresSpecializedOutput =
    metadata !== null &&
    specializedOutputModalities.some((modality) => metadata.outputModalities.includes(modality));
  // A record can exist without a modality block. Chat capability is only withheld on positive
  // metadata evidence; an id the directory described but did not classify stays selectable.
  const hasOutputEvidence =
    metadata !== null && metadata.hasModalityMetadata && metadata.outputModalities.length > 0;
  const looksSpecialized = specializedIdentifierPattern.test(id);

  let chatSelectable: boolean;
  let identifierFallback: boolean;
  if (embedding) {
    chatSelectable = false;
    identifierFallback = false;
  } else if (hasOutputEvidence) {
    // Metadata is authoritative: it may both grant and withhold chat capability.
    chatSelectable = declaresTextOutput && (!declaresSpecializedOutput || metadata!.toolCall);
    identifierFallback = false;
  } else {
    // No usable metadata: the model stays visible and manually selectable (an unknown future model
    // must not disappear), but it is not treated as evidence that the model is conversational. Only
    // a recognized embedding identifier positively excludes chat.
    chatSelectable = true;
    identifierFallback = true;
  }

  const capabilities = new Set<ModelCapability>();
  if (chatSelectable) capabilities.add('chat');
  if (metadata?.reasoning) capabilities.add('reasoning');
  if (metadata?.inputModalities.includes('image')) capabilities.add('vision-input');
  if (metadata?.toolCall) capabilities.add('tools');
  if (embedding) capabilities.add('embedding');
  const imageGeneration = hasOutputEvidence
    ? metadata!.outputModalities.includes('image')
    : imageIdentifierPattern.test(id);
  if (imageGeneration) capabilities.add('image-generation');
  if (metadata?.outputModalities.includes('audio')) capabilities.add('audio');
  if (metadata?.outputModalities.includes('video')) capabilities.add('video');
  if (metadata?.outputModalities.includes('pdf')) capabilities.add('pdf');

  const reason = chatSelectable
    ? undefined
    : embedding
      ? 'embedding model'
      : declaresSpecializedOutput
        ? 'specialized generation model'
        : 'not a conversational text model';

  return {
    id,
    metadata,
    capabilities: [...capabilities],
    chatSelectable,
    visionChatSelectable: chatSelectable && Boolean(metadata?.inputModalities.includes('image')),
    imageSelectable: imageGeneration,
    embedding,
    // Deprecated models are never a default, and an identifier-only catalog does not default to a
    // model whose name places it in a specialized generation family — that is what stops a live
    // `/models` list containing only image models from producing a false chat default.
    defaultEligible:
      chatSelectable && metadata?.deprecated !== true && !(identifierFallback && looksSpecialized),
    reason,
  };
}

/** Parses a provider-directory model map into catalog models, preserving directory metadata. */
export function catalogModelsFromDirectory(
  models: Record<string, ModelMetadataRecord> | undefined,
): CatalogModel[] {
  if (!models || typeof models !== 'object') return [];
  return Object.entries(models).flatMap(([id, record]) => {
    const trimmed = id.trim();
    if (!trimmed) return [];
    return [{ id: trimmed, metadata: parseModelMetadata(trimmed, record) }];
  });
}

/** Builds catalog models from plain ids (a live `/models` list carries no metadata). */
export function catalogModelsFromIds(
  ids: readonly string[],
  metadataById?: Readonly<Record<string, ModelCatalogMetadata>>,
): CatalogModel[] {
  return ids.map((id) => ({ id, metadata: metadataById?.[id] }));
}

/** Deterministic, order-preserving de-duplication of model ids. */
export function dedupeModelIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    deduped.push(trimmed);
  }
  return deduped;
}

/**
 * Deterministic model-id comparison. Code-point order is used rather than `localeCompare` so the
 * same catalog yields the same order (and the same default) regardless of the host locale.
 */
export function compareModelIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Sorted, de-duplicated, deterministic model id list. */
export function normalizedModelIds(ids: readonly string[]): string[] {
  return dedupeModelIds(ids).sort(compareModelIds);
}

/** Every model that IRIS would offer as a conversational chat model. */
export function chatSelectableModelIds(models: readonly CatalogModel[]): string[] {
  return models.filter((model) => classifyModel(model).chatSelectable).map((model) => model.id);
}

/** Every model usable for image generation. */
export function imageSelectableModelIds(models: readonly CatalogModel[]): string[] {
  return models.filter((model) => classifyModel(model).imageSelectable).map((model) => model.id);
}

/** Every embedding-capable model, deterministically sorted. */
export function embeddingModelIds(models: readonly CatalogModel[]): string[] {
  return models
    .filter((model) => classifyModel(model).embedding)
    .map((model) => model.id)
    .sort(compareModelIds);
}

/**
 * Deterministic default-model policy. Documented order:
 *   1. Only `defaultEligible` models are candidates (chat selectable and not deprecated). No
 *      candidate means the controlled state `no compatible chat model`, never a random pick.
 *   2. A trusted directory "recommended/default" marker wins when one exists (`defaultModelId`).
 *   3. Non-experimental models outrank experimental ones.
 *   4. Models whose identifier does not look like a specialized family outrank those that do
 *      (identifier evidence is only consulted where the directory cannot answer).
 *   5. Stable known capability ranking: tool-calling chat models outrank text-only ones.
 *   6. Final tie-break is ascending model id, so the same catalog always yields the same default.
 * Alphabetical position *over all models* is never used: that is how an image model became the
 * default chat model.
 */
export function selectDefaultChatModel(
  models: readonly CatalogModel[],
  options: { defaultModelId?: string } = {},
): string {
  const candidates = models.filter((model) => classifyModel(model).defaultEligible);
  if (!candidates.length) return '';
  if (options.defaultModelId) {
    const recommended = candidates.find((model) => model.id === options.defaultModelId);
    if (recommended) return recommended.id;
  }
  const rank = (model: CatalogModel): number => {
    const metadata = model.metadata;
    let score = 0;
    if (metadata?.experimental) score += 4;
    if (specializedIdentifierPattern.test(model.id)) score += 2;
    if (metadata && !metadata.toolCall) score += 1;
    return score;
  };
  const ranked = [...candidates].sort(
    (left, right) => rank(left) - rank(right) || compareModelIds(left.id, right.id),
  );
  return ranked[0].id;
}

/** The controlled-state label for a provider whose catalog has no chat-compatible model. */
export function defaultChatModelState(models: readonly CatalogModel[]): {
  model: string;
  message?: string;
} {
  const model = selectDefaultChatModel(models);
  return model ? { model } : { model: '', message: NO_COMPATIBLE_CHAT_MODEL };
}

/** The IRIS capability names a model classification maps onto. */
export function modelCapabilities(classification: ModelClassification): Capability[] {
  const capabilities: Capability[] = [];
  if (classification.chatSelectable) capabilities.push('chat');
  if (classification.capabilities.includes('tools')) capabilities.push('tools');
  if (classification.capabilities.includes('reasoning')) capabilities.push('reasoning');
  if (classification.visionChatSelectable) capabilities.push('vision');
  if (classification.embedding) capabilities.push('embeddings');
  return capabilities;
}
