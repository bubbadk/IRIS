// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  loadChannelConnection,
  loadChannelAttention,
  loadDurableChannelInbox,
  pollChannelOnce,
  sendTelegramMessage,
  sendDiscordWebhookMessage,
  projectData,
} = vi.hoisted(() => ({
  loadChannelConnection: vi.fn(),
  loadChannelAttention: vi.fn(async () => []),
  loadDurableChannelInbox: vi.fn(async () => []),
  pollChannelOnce: vi.fn(async () => ({ status: 'completed' as const })),
  sendTelegramMessage: vi.fn(async (params: { text: string }) => ({ ok: true, text: params.text })),
  sendDiscordWebhookMessage: vi.fn(async () => ({ ok: true })),
  projectData: {
    runs: [] as Array<Record<string, unknown>>,
    graph: null as Record<string, unknown> | null,
    onUpdate: null as ((projectId: string) => void) | null,
  },
}));

vi.mock('./bridgeGateway', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bridgeGateway')>()),
  loadChannelConnection,
  loadChannelAttention,
  loadDurableChannelInbox,
  pollChannelOnce,
  sendTelegramMessage,
  sendDiscordWebhookMessage,
}));
vi.mock('./channelApprovals', () => ({ resolveRemoteApproval: vi.fn(async () => null) }));
vi.mock('./persistence', () => ({
  projectGraphRepository: {
    get: vi.fn(async () => projectData.graph),
  },
  projectTaskRunRepository: {
    list: vi.fn(async (projectId?: string) =>
      projectId ? projectData.runs.filter((run) => run.projectId === projectId) : projectData.runs,
    ),
  },
}));
vi.mock('./projectRuntime', () => ({
  subscribeProjectRuntime: vi.fn((listener: (projectId: string) => void) => {
    projectData.onUpdate = listener;
    return () => {
      projectData.onUpdate = null;
    };
  }),
}));

import {
  channelRuntimeStatus,
  startChannelRuntime,
  subscribeChannelRuntime,
} from './channelRuntime';

describe('root channel runtime', () => {
  afterEach(() => {
    vi.clearAllMocks();
    projectData.runs = [];
    projectData.graph = null;
    projectData.onUpdate = null;
    vi.useRealTimers();
  });

  it('checks saved Telegram connections without mounting the Channels window', async () => {
    vi.useFakeTimers();
    loadChannelConnection.mockResolvedValue({
      telegram: {
        enabled: true,
        botToken: 'test-token',
        allowedChatIds: ['chat-1'],
        lastUpdateId: 0,
      },
      discord: { enabled: false, webhookUrl: '' },
    });
    const stop = startChannelRuntime(12_000);
    await vi.waitFor(() => expect(pollChannelOnce).toHaveBeenCalledOnce());
    expect(channelRuntimeStatus().state).toBe('connected');

    await vi.advanceTimersByTimeAsync(12_000);
    expect(pollChannelOnce).toHaveBeenCalledTimes(2);
    stop();
  });

  it('retains a visible status when no messaging connection is configured', async () => {
    loadChannelConnection.mockResolvedValue({
      telegram: {
        enabled: false,
        botToken: '',
        allowedChatIds: [],
        lastUpdateId: 0,
      },
      discord: { enabled: false, webhookUrl: '' },
    });
    const seen: string[] = [];
    const unsubscribe = subscribeChannelRuntime((next) => seen.push(next.message));
    const stop = startChannelRuntime(60_000);
    await vi.waitFor(() => expect(channelRuntimeStatus().state).toBe('idle'));
    expect(pollChannelOnce).not.toHaveBeenCalled();
    expect(seen).toContain('No Telegram connection is enabled.');
    stop();
    unsubscribe();
  });

  it('sends only opt-in, generic project status updates without worker output', async () => {
    loadChannelConnection.mockResolvedValue({
      telegram: {
        enabled: true,
        notifyOnProjectUpdates: true,
        botToken: 'test-token',
        allowedChatIds: ['chat-1'],
        lastUpdateId: 0,
      },
      discord: {
        enabled: true,
        notifyOnProjectUpdates: false,
        webhookUrl: 'https://discord.invalid/webhook',
      },
    });
    projectData.graph = {
      id: 'project-1',
      title: 'Release prep',
      tasks: [{ id: 'task-1', title: 'Write notes' }],
    };
    projectData.runs = [
      {
        id: 'run-1',
        projectId: 'project-1',
        taskId: 'task-1',
        status: 'running',
        output: 'private worker output',
      },
    ];
    const stop = startChannelRuntime(60_000);
    await vi.waitFor(() => expect(projectData.onUpdate).toBeTypeOf('function'));
    projectData.runs[0]!.status = 'awaiting-review';
    projectData.runs[0]!.output = 'private worker output';
    projectData.onUpdate!('project-1');

    await vi.waitFor(() => expect(sendTelegramMessage).toHaveBeenCalledOnce());
    const sent = sendTelegramMessage.mock.calls[0]![0].text;
    expect(sent).toContain('ready for your review');
    expect(sent).not.toContain('private worker output');
    expect(sendDiscordWebhookMessage).not.toHaveBeenCalled();
    stop();
  });
});
