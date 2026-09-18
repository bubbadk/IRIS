import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  describeApproval,
  formatApprovalLine,
  formatApprovalText,
  isSensitiveFieldName,
  redactInlineSecrets,
  redactSensitiveInput,
} from './approvalSummary';

/** Everything a surface could render, so a leaked value cannot hide in a corner. */
function everythingRendered(input: unknown, toolId: string, toolName: string): string {
  const description = describeApproval({ toolId, toolName, input });
  return [
    description.headline,
    ...description.details,
    JSON.stringify(description.redactedInput),
    formatApprovalText(description),
    formatApprovalLine(description),
  ].join('\n');
}

describe('describeApproval names the concrete operation', () => {
  it('shows a shell command together with its isolation mode', () => {
    const description = describeApproval({
      toolId: 'shell.exec',
      toolName: 'Shell execute',
      risk: 'execute',
      input: { command: 'rm -rf build', isolation: 'host' },
      agentName: 'IRIS',
    });
    expect(description.headline).toBe('Run shell command · isolation: host');
    expect(description.details[0]).toBe('Command · rm -rf build');
    expect(description.details[1]).toBe('Isolation · host');
    expect(formatApprovalText(description)).toContain('rm -rf build');
  });

  it('shows the target path for a destructive workspace delete', () => {
    const description = describeApproval({
      toolId: 'workspace.delete',
      toolName: 'Delete workspace entry',
      input: { path: 'notes/private' },
    });
    expect(description.headline).toBe('Delete notes/private');
    expect(description.details.join('\n')).toContain('Delete path · notes/private');
  });

  it('shows the target and the exact command for the Janitor tool', () => {
    const description = describeApproval({
      toolId: 'janitor.command',
      toolName: 'Run Janitor command',
      input: { target: 'local', command: 'sudo systemctl restart docker' },
    });
    expect(description.headline).toBe('Run Janitor command on local');
    expect(description.details).toContain('Command · sudo systemctl restart docker');
    expect(description.details).toContain('Target · local');
  });

  it('shows repository, ref and action for a GitHub publication', () => {
    const description = describeApproval({
      toolId: 'github.create_pull_request',
      toolName: 'Create pull request',
      input: { repo: 'bubbadk/IRIS', ref: 'phase-2d', action: 'open pull request' },
    });
    expect(description.headline).toBe('GitHub publication · bubbadk/IRIS');
    expect(description.details).toEqual([
      'Repository · bubbadk/IRIS',
      'Ref · phase-2d',
      'Action · open pull request',
    ]);
  });

  it('shows role and objective for a delegated sub-agent', () => {
    const description = describeApproval({
      toolId: 'subagent.delegate',
      toolName: 'Delegate to sub-agent',
      input: { role: 'Reviewer', objective: 'Review the diff for secrets' },
    });
    expect(description.headline).toBe('Delegate to sub-agent · Reviewer');
    expect(description.details).toContain('Objective · Review the diff for secrets');
  });

  it('describes an unknown tool from its complete arguments instead of hiding them', () => {
    const description = describeApproval({
      toolId: 'custom.tool',
      toolName: 'Custom tool',
      input: { first: 'one', second: 2 },
    });
    expect(description.details).toEqual(['first · one', 'second · 2']);
  });

  it('never invents a risk level that was not supplied', () => {
    expect(describeApproval({ toolId: 'a.b', toolName: 'B', input: {} }).risk).toBeUndefined();
  });
});

describe('secret redaction', () => {
  it('recognizes credential-shaped field names', () => {
    for (const name of [
      'apiKey',
      'API_KEY',
      'authorization',
      'accessToken',
      'clientSecret',
      'password',
      'passwd',
      'passphrase',
      'privateKey',
      'credentials',
      'bearerToken',
    ]) {
      expect(isSensitiveFieldName(name), name).toBe(true);
    }
    for (const name of ['command', 'path', 'isolation', 'target', 'repo', 'objective', 'author']) {
      expect(isSensitiveFieldName(name), name).toBe(false);
    }
  });

  it('replaces a credential value while keeping the operation visible', () => {
    const description = describeApproval({
      toolId: 'shell.exec',
      toolName: 'Shell execute',
      input: { command: 'curl https://api.example.com', apiKey: 'sk-live-secret-value' },
    });
    const rendered = everythingRendered(
      { command: 'curl https://api.example.com', apiKey: 'sk-live-secret-value' },
      'shell.exec',
      'Shell execute',
    );
    expect(rendered).toContain('curl https://api.example.com');
    expect(rendered).toContain(REDACTED);
    expect(rendered).not.toContain('sk-live-secret-value');
    expect(description.redacted).toBe(true);
  });

  it('redacts nested objects and arrays without dropping the rest of the arguments', () => {
    const rendered = everythingRendered(
      {
        path: 'notes/today.md',
        headers: { authorization: 'Bearer abc123456789', accept: 'text/plain' },
        extras: [{ token: 't-999', label: 'keep me' }],
      },
      'workspace.write',
      'Write file',
    );
    expect(rendered).not.toContain('abc123456789');
    expect(rendered).not.toContain('t-999');
    expect(rendered).toContain('keep me');
    expect(rendered).toContain('text/plain');
    expect(rendered).toContain('notes/today.md');
  });

  it('scrubs credentials pasted into otherwise visible text', () => {
    const rendered = everythingRendered(
      { command: 'curl -H "Authorization: Bearer sk-abc123456789" https://example.com' },
      'shell.exec',
      'Shell execute',
    );
    expect(rendered).not.toContain('sk-abc123456789');
    expect(rendered).toContain('https://example.com');
  });

  it('leaves ordinary commands untouched', () => {
    const command = 'rm -rf build && git status --short';
    expect(redactInlineSecrets(command)).toBe(command);
    expect(everythingRendered({ command, isolation: 'workspace' }, 'shell.exec', 'Shell')).toContain(
      command,
    );
  });

  it('still names a credential argument explicitly instead of hiding it', () => {
    const description = describeApproval({
      toolId: 'shell.exec',
      toolName: 'Shell execute',
      input: { command: 'curl https://example.com', apiKey: 'sk-live-abcdef123456' },
    });
    expect(description.details).toContain('apiKey · [REDACTED]');
    expect(description.details.join('\n')).not.toContain('sk-live-abcdef123456');
  });

  it('reports whether anything was redacted', () => {
    expect(redactSensitiveInput({ command: 'ls' }).redacted).toBe(false);
    expect(redactSensitiveInput({ command: 'ls', token: 'x' }).redacted).toBe(true);
  });

  it('leaves primitive inputs intact', () => {
    expect(redactSensitiveInput('plain string')).toEqual({ value: 'plain string', redacted: false });
    expect(redactSensitiveInput(null)).toEqual({ value: null, redacted: false });
    expect(redactSensitiveInput(7)).toEqual({ value: 7, redacted: false });
  });
});
