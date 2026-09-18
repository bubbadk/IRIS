import { describe, expect, it } from 'vitest';
import type { ToolApprovalRequest } from '@iris/tools';
import { parseRemoteApproval, remoteApprovalMessage } from './channelApprovals';

function approvalOf(input: unknown): ToolApprovalRequest {
  return {
    id: 'approval-7',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    agentId: 'agent-1',
    agentName: 'IRIS',
    toolId: 'shell.exec',
    toolName: 'Shell execute',
    input,
    evaluation: { decision: 'ask', reason: 'Ask before running a host command.' },
  };
}

describe('remote approval command parsing', () => {
  it('requires one explicit decision and a bounded approval id', () => {
    expect(parseRemoteApproval('approve approval-1')).toEqual({
      decision: 'approve',
      approvalId: 'approval-1',
    });
    expect(parseRemoteApproval('deny project:approval_2')).toEqual({
      decision: 'deny',
      approvalId: 'project:approval_2',
    });
    expect(parseRemoteApproval('approve approval-1 now')).toBeNull();
    expect(parseRemoteApproval('run approval-1')).toBeNull();
  });
});

describe('remote approval message', () => {
  it('names the concrete operation and how to decide it', () => {
    const message = remoteApprovalMessage(
      approvalOf({ command: 'sudo systemctl restart docker', isolation: 'host' }),
    );
    expect(message).toContain('Approval approval-7 is waiting.');
    expect(message).toContain('Command · sudo systemctl restart docker');
    expect(message).toContain('Isolation · host');
    expect(message).toContain('approve approval-7');
    expect(message).toContain('deny approval-7');
  });

  it('never puts a credential in the remote message', () => {
    const message = remoteApprovalMessage(
      approvalOf({ command: 'curl https://example.com', apiKey: 'sk-live-abcdef123456' }),
    );
    expect(message).not.toContain('sk-live-abcdef123456');
    expect(message).toContain('[REDACTED]');
    expect(message).toContain('curl https://example.com');
  });
});
