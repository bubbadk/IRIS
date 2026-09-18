import type { ToolRisk } from './index';

/**
 * The one approval formatter.
 *
 * Every surface that asks a human to approve a tool invocation — the chat composer, the global
 * permissions window, the schedules view, the project stream, a remote/channel reply — renders
 * through this module, so the same invocation is described the same way everywhere. It exists
 * because "Shell execute wants permission" is not consent: the user must be able to see the
 * concrete operation (command, arguments, isolation, target, path) that is about to run.
 *
 * Two rules hold here and are covered by tests:
 * 1. Security-critical arguments are never hidden. Non-secret operation details — a shell command,
 *    a target path, an isolation mode — are shown verbatim.
 * 2. A value under a credential-shaped key is replaced with [`REDACTED`] before it can reach a
 *    screen, a transcript, a log or a remote message. The original input stays on the approval
 *    record itself for execution; only the display is redacted.
 */

export const REDACTED = '[REDACTED]';

/** Human-facing description of one approval request. */
export interface ApprovalDescription {
  toolId: string;
  toolName: string;
  risk?: ToolRisk;
  agentName?: string;
  /** One line naming the concrete operation. */
  headline: string;
  /** The security-critical arguments, most important first. */
  details: string[];
  /** The full input with credentials replaced. Never the raw secrets. */
  redactedInput: unknown;
  /** True when at least one value was replaced by the redaction marker. */
  redacted: boolean;
}

export interface ApprovalDescriptionInput {
  toolId: string;
  toolName: string;
  risk?: ToolRisk;
  input: unknown;
  agentName?: string;
}

const normalizedSensitiveNames = [
  'apikey',
  'authorization',
  'bearer',
  'token',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'privatekey',
  'credential',
  'clientsecret',
] as const;

/** True for a field name that must never be displayed with its value. */
export function isSensitiveFieldName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalizedSensitiveNames.some((sensitive) => normalized.includes(sensitive));
}

const inlineSecretPatterns: Array<[RegExp, string]> = [
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/(authorization\s*[:=]\s*)([^\s'"]+)/gi, '$1[REDACTED]'],
  [/((?:--?password|passwd|passphrase)\s*[=:]?\s*)([^\s'"]+)/gi, '$1[REDACTED]'],
];

/** Scrubs credential-shaped fragments that a caller pasted into otherwise visible text. */
export function redactInlineSecrets(value: string): string {
  return inlineSecretPatterns.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );
}

function redactValue(value: unknown, depth: number): { value: unknown; redacted: boolean } {
  if (depth > 12) return { value: '[truncated]', redacted: false };
  if (typeof value === 'string') {
    const scrubbed = redactInlineSecrets(value);
    return { value: scrubbed, redacted: scrubbed !== value };
  }
  if (Array.isArray(value)) {
    let redacted = false;
    const items = value.map((entry) => {
      const result = redactValue(entry, depth + 1);
      redacted = redacted || result.redacted;
      return result.value;
    });
    return { value: items, redacted };
  }
  if (value && typeof value === 'object') {
    let redacted = false;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveFieldName(key)) {
        output[key] = REDACTED;
        redacted = true;
        continue;
      }
      const result = redactValue(entry, depth + 1);
      redacted = redacted || result.redacted;
      output[key] = result.value;
    }
    return { value: output, redacted };
  }
  return { value, redacted: false };
}

/** Deep-copies `input`, replacing credential-shaped values with [`REDACTED`]. */
export function redactSensitiveInput(input: unknown): { value: unknown; redacted: boolean } {
  return redactValue(input, 0);
}

function text(value: unknown, limit = 400): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function field(input: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (input[name] !== undefined) return input[name];
  }
  return undefined;
}

function bool(value: unknown): string | undefined {
  return typeof value === 'boolean' ? (value ? 'yes' : 'no') : undefined;
}

/**
 * Per-tool summarisers. Each returns the headline and the arguments a user must see before
 * approving. Unknown tools fall back to a complete field dump, so nothing is ever silently hidden.
 */
interface ToolSummary {
  headline: string;
  details: string[];
  /** The input keys this summary already accounts for; everything else is appended verbatim. */
  covered: string[];
}

/**
 * Per-tool summarisers. Each returns the headline and the arguments a user must see before
 * approving, and declares which keys it covered. Unknown tools and uncovered keys fall back to a
 * complete field dump, so no argument is ever silently hidden from the prompt.
 */
const summarizers: Record<string, (input: Record<string, unknown>) => ToolSummary> = {
  'shell.exec': (input) => {
    const isolation = text(field(input, 'isolation')) ?? 'workspace';
    return {
      headline: `Run shell command · isolation: ${isolation}`,
      details: [
        `Command · ${text(field(input, 'command')) ?? '(empty)'}`,
        `Isolation · ${isolation}`,
        ...(field(input, 'timeoutSeconds') !== undefined
          ? [`Timeout · ${String(field(input, 'timeoutSeconds'))}s`]
          : []),
      ],
      covered: ['command', 'isolation', 'timeoutSeconds'],
    };
  },
  'janitor.command': (input) => {
    const target = text(field(input, 'target')) ?? '(unset)';
    return {
      headline: `Run Janitor command on ${target}`,
      details: [
        `Target · ${target}`,
        `Command · ${text(field(input, 'command'), 2000) ?? '(empty)'}`,
      ],
      covered: ['target', 'command'],
    };
  },
  'janitor.health': (input) => {
    const target = text(field(input, 'target')) ?? '(unset)';
    return {
      headline: `Run read-only Janitor health check on ${target}`,
      details: [`Target · ${target}`, `Check · ${text(field(input, 'check')) ?? '(unset)'}`],
      covered: ['target', 'check'],
    };
  },
  'workspace.delete': (input) => ({
    headline: `Delete ${text(field(input, 'path')) ?? 'a workspace entry'}`,
    details: [
      `Delete path · ${text(field(input, 'path')) ?? '(unset)'}`,
      'Scope · inside the mounted workspace (recursive for directories)',
    ],
    covered: ['path'],
  }),
  'workspace.write': (input) => ({
    headline: `Write ${text(field(input, 'path')) ?? 'a file'}`,
    details: [
      `Path · ${text(field(input, 'path')) ?? '(unset)'}`,
      ...(typeof field(input, 'content') === 'string'
        ? [
            `Content · ${(field(input, 'content') as string).length} characters`,
            `Content preview · ${text(field(input, 'content'), 280) ?? ''}`,
          ]
        : []),
      ...(field(input, 'overwrite') !== undefined
        ? [`Overwrite · ${bool(field(input, 'overwrite'))}`]
        : []),
    ],
    covered: ['path', 'content', 'overwrite'],
  }),
  'workspace.patch': (input) => ({
    headline: `Patch ${text(field(input, 'path')) ?? 'a file'}`,
    details: [
      `Path · ${text(field(input, 'path')) ?? '(unset)'}`,
      `Expected content · ${
        typeof field(input, 'expectedContent') === 'string'
          ? `${(field(input, 'expectedContent') as string).length} characters`
          : '(unset)'
      }`,
      `Updated content · ${
        typeof field(input, 'updatedContent') === 'string'
          ? `${(field(input, 'updatedContent') as string).length} characters`
          : '(unset)'
      }`,
      `Updated preview · ${text(field(input, 'updatedContent'), 280) ?? ''}`,
    ],
    covered: ['path', 'expectedContent', 'updatedContent'],
  }),
  'workspace.move': (input) => ({
    headline: `Move ${text(field(input, 'sourcePath')) ?? '?'} → ${text(field(input, 'targetPath')) ?? '?'}`,
    details: [
      `Move from · ${text(field(input, 'sourcePath')) ?? '(unset)'}`,
      `Move to · ${text(field(input, 'targetPath')) ?? '(unset)'}`,
      ...(field(input, 'overwrite') !== undefined
        ? [`Overwrite · ${bool(field(input, 'overwrite'))}`]
        : []),
    ],
    covered: ['sourcePath', 'targetPath', 'overwrite'],
  }),
};

function githubSummary(input: Record<string, unknown>): ToolSummary {
  const repo = text(field(input, 'repo', 'repository', 'fullName')) ?? '(unset)';
  const ref = text(field(input, 'ref', 'branch', 'tag', 'base'));
  const action = text(field(input, 'action', 'event', 'workflow', 'title'));
  return {
    headline: `GitHub publication · ${repo}`,
    details: [
      `Repository · ${repo}`,
      ...(ref ? [`Ref · ${ref}`] : []),
      ...(action ? [`Action · ${action}`] : []),
      ...(text(field(input, 'path')) ? [`Path · ${text(field(input, 'path'))}`] : []),
    ],
    covered: ['repo', 'repository', 'fullName', 'ref', 'branch', 'tag', 'base', 'action', 'event', 'workflow', 'title', 'path'],
  };
}

function subAgentSummary(input: Record<string, unknown>): ToolSummary {
  const role = text(field(input, 'role')) ?? 'Specialist';
  return {
    headline: `Delegate to sub-agent · ${role}`,
    details: [
      `Role · ${role}`,
      `Objective · ${text(field(input, 'objective'), 600) ?? '(unset)'}`,
      ...(text(field(input, 'model')) ? [`Model · ${text(field(input, 'model'))}`] : []),
    ],
    covered: ['role', 'objective', 'model'],
  };
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return redactInlineSecrets(value);
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }
  return String(value);
}

/** Formats one approval request into a surface-independent description. */
export function describeApproval(request: ApprovalDescriptionInput): ApprovalDescription {
  const { value: redactedInput, redacted } = redactSensitiveInput(request.input);
  const record =
    redactedInput && typeof redactedInput === 'object' && !Array.isArray(redactedInput)
      ? (redactedInput as Record<string, unknown>)
      : undefined;

  let headline = request.toolName;
  let details: string[] = [];
  if (record) {
    const summarizer =
      summarizers[request.toolId] ??
      (request.toolId.startsWith('github.') ? githubSummary : undefined) ??
      (request.toolId.startsWith('subagent.') ? subAgentSummary : undefined);
    const summary: ToolSummary = summarizer
      ? summarizer(record)
      : {
          headline: request.toolName,
          details: [],
          covered: [],
        };
    headline = summary.headline;
    details = [...summary.details];
    // Anything the tool-specific summary did not name is appended verbatim (already redacted), so a
    // credential-shaped argument still appears as `apiKey · [REDACTED]` rather than vanishing — and
    // no other argument can hide behind a known summariser either.
    const uncovered = Object.entries(record).filter(([key]) => !summary.covered.includes(key));
    details.push(...uncovered.map(([key, value]) => `${key} · ${renderValue(value)}`));
  } else if (redactedInput !== undefined && redactedInput !== null) {
    details = [`Input · ${renderValue(redactedInput)}`];
  }

  return {
    toolId: request.toolId,
    toolName: request.toolName,
    ...(request.risk ? { risk: request.risk } : {}),
    ...(request.agentName ? { agentName: request.agentName } : {}),
    headline,
    details,
    redactedInput,
    redacted,
  };
}

/** The compact multi-line form used by chat, the permissions window and remote replies. */
export function formatApprovalText(description: ApprovalDescription): string {
  const header = [description.toolName, description.toolId, description.risk]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  return [header, description.headline, ...description.details.map((line) => `  ${line}`)].join(
    '\n',
  );
}

/** A single line for budgeted surfaces such as the activity feed. */
export function formatApprovalLine(description: ApprovalDescription): string {
  const detail = description.details[0];
  return detail ? `${description.headline} — ${detail}` : description.headline;
}
