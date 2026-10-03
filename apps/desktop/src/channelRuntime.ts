import {
  ChannelEffectCompletedError,
  ChannelEffectRetryableError,
  loadChannelAttention,
  loadChannelConnection,
  loadDurableChannelInbox,
  pollChannelOnce,
  sendDiscordWebhookMessage,
  sendTelegramMessage,
  type ChannelUpdateAttention,
} from './bridgeGateway';
import { resolveRemoteApproval } from './channelApprovals';
import { projectGraphRepository, projectTaskRunRepository } from './persistence';
import { subscribeProjectRuntime } from './projectRuntime';

export interface ChannelRuntimeStatus {
  state: 'idle' | 'polling' | 'connected' | 'needs-attention' | 'unavailable';
  message: string;
  attention: ChannelUpdateAttention[];
  updatedAt?: string;
}

const POLL_INTERVAL_MS = 12_000;
let status: ChannelRuntimeStatus = {
  state: 'idle',
  message: 'Channel runtime is waiting for a saved connection.',
  attention: [],
};
const listeners = new Set<(next: ChannelRuntimeStatus) => void>();
let activeRuntime: ReturnType<typeof createRuntime> | null = null;

function publish(next: ChannelRuntimeStatus): void {
  status = next;
  listeners.forEach((listener) => listener(status));
}

export function channelRuntimeStatus(): ChannelRuntimeStatus {
  return status;
}

export function subscribeChannelRuntime(
  listener: (next: ChannelRuntimeStatus) => void,
): () => void {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
}

async function pollSavedChannel(isActive: () => boolean): Promise<void> {
  try {
    const config = await loadChannelConnection();
    if (!isActive()) return;
    if (
      !config.telegram.enabled ||
      !config.telegram.botToken ||
      !config.telegram.allowedChatIds.length
    ) {
      const attention = await loadChannelAttention().catch(() => status.attention);
      if (isActive()) {
        publish({
          state: attention.length ? 'needs-attention' : 'idle',
          message: attention.length
            ? `${attention.length} Telegram update${attention.length === 1 ? '' : 's'} need attention.`
            : 'No Telegram connection is enabled.',
          attention,
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }

    publish({ ...status, state: 'polling', message: 'Checking the saved Telegram inbox.' });
    const result = await pollChannelOnce({
      config,
      isActive,
      handle: async (message) => {
        let outcome: string | null;
        try {
          outcome = await resolveRemoteApproval(message.text);
        } catch {
          throw new ChannelEffectRetryableError();
        }
        if (outcome) {
          const sent = await sendTelegramMessage({
            botToken: config.telegram.botToken,
            chatId: message.chatId,
            text: outcome,
          });
          // Approval settlement has already committed. Do not replay it if this acknowledgement
          // fails; the durable update ledger will surface the uncertain delivery for inspection.
          if (!sent.ok) throw new ChannelEffectCompletedError();
        }
      },
    });
    if (!isActive() || result.status === 'skipped') return;
    const [attention, inbox] = await Promise.all([
      loadChannelAttention(),
      loadDurableChannelInbox(),
    ]);
    if (!isActive()) return;
    const message =
      result.error ??
      (attention.length
        ? `${attention.length} Telegram update${attention.length === 1 ? '' : 's'} need attention.`
        : result.status === 'completed'
          ? 'Telegram inbox checked.'
          : `Telegram polling ${result.status}.`);
    publish({
      state: result.error || attention.length ? 'needs-attention' : 'connected',
      message: inbox.length ? `${message} ${inbox.length} inbox messages saved.` : message,
      attention,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    if (isActive()) {
      publish({
        ...status,
        state: 'unavailable',
        message: 'Telegram could not be checked. Saved inbox data was retained.',
        updatedAt: new Date().toISOString(),
      });
    }
  }
}

function createRuntime(intervalMs: number) {
  let active = true;
  let polling = false;
  const observedRuns = new Map<string, string>();
  const terminalStatuses = new Set(['awaiting-review', 'needs-attention', 'failed', 'completed']);

  const initialRuns = projectTaskRunRepository.list().then((runs) => {
    if (!active) return;
    for (const run of runs) observedRuns.set(run.id, run.status);
  });

  let notificationChain = initialRuns;
  const unsubscribeProjects = subscribeProjectRuntime((projectId) => {
    notificationChain = notificationChain
      .then(async () => {
        if (!active) return;
        const [project, runs, config] = await Promise.all([
          projectGraphRepository.get(projectId),
          projectTaskRunRepository.list(projectId),
          loadChannelConnection(),
        ]);
        if (!active) return;
        const taskNames = new Map(project?.tasks.map((task) => [task.id, task.title]));
        for (const run of runs) {
          const previousStatus = observedRuns.get(run.id);
          observedRuns.set(run.id, run.status);
          if (previousStatus === run.status || !terminalStatuses.has(run.status)) continue;
          const result =
            run.status === 'awaiting-review'
              ? 'is ready for your review'
              : run.status === 'needs-attention'
                ? 'needs attention and remains unfinished'
                : run.status === 'failed'
                  ? 'stopped with an error and remains unfinished'
                  : 'was completed after review';
          const text = `IRIS project update: “${project?.title ?? run.projectId}” — “${taskNames.get(run.taskId) ?? run.taskId}” ${result}. Run ${run.id}.`;
          const deliveries: Promise<{ ok: boolean }>[] = [];
          if (
            config.telegram.enabled &&
            config.telegram.notifyOnProjectUpdates &&
            config.telegram.botToken
          ) {
            deliveries.push(
              ...config.telegram.allowedChatIds.map((chatId) =>
                sendTelegramMessage({
                  botToken: config.telegram.botToken,
                  chatId,
                  text,
                }),
              ),
            );
          }
          if (
            config.discord.enabled &&
            config.discord.notifyOnProjectUpdates &&
            config.discord.webhookUrl
          ) {
            deliveries.push(
              sendDiscordWebhookMessage({ webhookUrl: config.discord.webhookUrl, content: text }),
            );
          }
          if (deliveries.length) {
            const results = await Promise.all(deliveries);
            if (results.some((delivery) => !delivery.ok)) {
              publish({
                ...status,
                state: 'needs-attention',
                message:
                  'A project update could not be confirmed by every enabled channel. Check the connection before retrying; IRIS did not resend it.',
                updatedAt: new Date().toISOString(),
              });
            }
          }
        }
      })
      .catch(() => {
        if (active)
          publish({
            ...status,
            state: 'needs-attention',
            message: 'Project updates could not be checked for channel delivery.',
            updatedAt: new Date().toISOString(),
          });
      });
  });

  const poll = async () => {
    if (!active || polling) return;
    polling = true;
    try {
      await pollSavedChannel(() => active);
    } finally {
      polling = false;
    }
  };
  void poll();
  const timer = window.setInterval(() => void poll(), intervalMs);
  return {
    stop() {
      active = false;
      unsubscribeProjects();
      window.clearInterval(timer);
    },
  };
}

/** Start once at the desktop root so inbox polling survives opening and closing the Channels view. */
export function startChannelRuntime(intervalMs = POLL_INTERVAL_MS): () => void {
  if (!activeRuntime) activeRuntime = createRuntime(intervalMs);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    activeRuntime?.stop();
    activeRuntime = null;
  };
}
