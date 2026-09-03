/**
 * Turn-trace observability for IRIS agent sessions. A trace is an ordered log of structured
 * decision-point events that occurred during a single cortex turn. Traces are optional on
 * CortexTurnRecord so existing serialized turns without traces continue to load unchanged.
 * Unknown event types are preserved verbatim for forward compatibility.
 */

export type TurnTraceEvent =
  | { type: 'reasoning-effort-changed'; from: string; to: string; reason: string }
  | { type: 'history-trimmed'; droppedCount: number; budgetChars: number; remainingChars: number }
  | { type: 'tool-batch-decision'; totalCalls: number; concurrencyLimit: number; batched: boolean }
  | { type: 'approval-queued'; toolName: string; queuedCount: number }
  | { type: 'context-source-selected'; source: string; recordCount: number };

export interface TurnTraceRecord {
  turnId: string;
  agentId: string;
  events: TurnTraceEvent[];
  createdAt: string;
}

/** Returns a new array with the event appended. Pure function — does not mutate input. */
export function appendTraceEvent(
  events: TurnTraceEvent[],
  event: TurnTraceEvent,
): TurnTraceEvent[] {
  return [...events, event];
}