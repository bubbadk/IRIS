import { describe, expect, it } from 'vitest';
import { createDelegationContext } from '@iris/core';
import {
  allowRules,
  childPlan,
  collect,
  createIntegrationHarness,
  delegateAllow,
  delegateCallName,
  depthAwareResolver,
  parentPlan,
  planProvider,
  rootAgent,
  ruleGatedToolId,
  teamCallName,
} from './delegationHarness';

describe('delegated sub-agent approval lifecycle through the real coordinator', () => {
  /**
   * The end-to-end path the H-02 audit demanded: parent → real delegation → child tool call →
   * approval-required → resolution through the permission UI's own path → child resume → terminal
   * child result.
   */
  it('suspends the child turn, resumes it on approval, and runs the tool exactly once', async () => {
    const root = rootAgent();
    const harness = createIntegrationHarness({
      agents: [root],
      rules: [
        ...allowRules(root.id),
        { id: 'root-ask', agentId: root.id, toolId: ruleGatedToolId, decision: 'ask' },
      ],
      resolve: depthAwareResolver(parentPlan(), childPlan()),
    });

    const parentEvents = await collect(await harness.coordinator.send(root.id, 'Reconfigure now'));

    // 1. The parent did not finish: its delegation handed work to a child that is waiting for
    //    approval, so the parent turn is suspended and never claims a result it does not have.
    expect(parentEvents.map((event) => event.type)).toContain('tool-suspended');
    expect(
      parentEvents.some(
        (event) => event.type === 'tool-complete' || event.type === 'assistant-complete',
      ),
    ).toBe(false);

    // 2. Both the parent and the child are recorded as suspended — the parent on the child's
    //    approval, the child on the tool it must run.
    const parentSuspension = await harness.coordinator.suspendedForAgent(root.id);
    expect(parentSuspension?.pending.kind).toBe('delegation');
    expect(harness.approvals.requests).toHaveLength(1);
    const approvalId = harness.approvals.requests[0].id;

    // 3. The permission UI's exact lookup finds the child turn that OWNS the approval.
    const suspended = await harness.coordinator.suspendedForApproval(approvalId);
    expect(suspended).not.toBeNull();
    expect(suspended!.agentId).toMatch(/^subagent-/);
    expect(suspended!.delegatedAgent).toBeDefined();
    expect(suspended!.delegationChain).toEqual({
      depth: 1,
      ancestors: [{ id: root.id, approvalMode: 'ask' }],
    });
    // Nothing ran while the approval was pending.
    expect(harness.executions).toHaveLength(0);

    // 4. Resolving through the coordinator resumes the child, exactly as the Permissions UI does,
    //    and then walks the chain back up to the parent that was waiting for it.
    const resumeEvents = await collect(
      harness.coordinator.resolveApproval(approvalId, 'approve'),
    );

    expect(resumeEvents.map((event) => event.type)).toContain('tool-complete');
    const childCompletion = resumeEvents
      .filter((event) => event.type === 'assistant-complete')
      .at(0) as { message: { content: string } };
    expect(childCompletion.message.content).toContain('"configured":true');
    // The parent received the child's real report and finished truthfully.
    const parentCompletion = resumeEvents
      .filter((event) => event.type === 'assistant-complete')
      .at(-1) as { message: { content: string } };
    expect(parentCompletion.message.content).toContain('Parent report:');
    expect(parentCompletion.message.content).toContain('"status":"completed"');
    // The parent's report carries the child's real recorded answer, not a re-run.
    expect(parentCompletion.message.content).toContain('Child report:');
    expect(parentCompletion.message.content).toContain('configured');

    // 5. Exactly one execution, a completed approval, and no leftover suspension anywhere.
    expect(harness.executions).toEqual([{ setting: 'enabled' }]);
    expect(harness.approvals.requests[0].status).toBe('completed');
    expect(await harness.coordinator.suspendedForApproval(approvalId)).toBeNull();
    expect(await harness.coordinator.suspendedForAgent(root.id)).toBeNull();
    expect(harness.suspended.turns).toHaveLength(0);

    // 6. The child's report is durable, so its output is not lost with the turn.
    const childConversation = await harness.conversations.list(suspended!.agentId);
    expect(childConversation.at(-1)?.content).toContain('Child report:');
    // The child never became a roster agent.
    await expect(harness.agents.get(suspended!.agentId)).resolves.toBeNull();
  });

  /** Test C/H: denial executes nothing and the child turn still terminates truthfully. */
  it('executes nothing when the delegated approval is denied', async () => {
    const root = rootAgent();
    const harness = createIntegrationHarness({
      agents: [root],
      rules: [
        ...allowRules(root.id),
        { id: 'root-ask', agentId: root.id, toolId: ruleGatedToolId, decision: 'ask' },
      ],
      resolve: depthAwareResolver(parentPlan(), childPlan()),
    });

    await collect(await harness.coordinator.send(root.id, 'Reconfigure now'));
    const approvalId = harness.approvals.requests[0].id;

    const resumeEvents = await collect(harness.coordinator.resolveApproval(approvalId, 'deny'));

    expect(resumeEvents.map((event) => event.type)).toContain('tool-denied');
    expect(resumeEvents.map((event) => event.type)).toContain('assistant-complete');
    expect(harness.executions).toHaveLength(0);
    expect(harness.approvals.requests[0].status).toBe('denied');
    expect(await harness.coordinator.suspendedForApproval(approvalId)).toBeNull();
  });

  /** Attack E: YOLO everywhere still cannot wave a mandatory approval through. */
  it('requires approval for a YOLO parent delegating to a mandatory-approval tool', async () => {
    const root = rootAgent({ approvalMode: 'yolo' });
    const harness = createIntegrationHarness({
      agents: [root],
      rules: allowRules(root.id),
      resolve: depthAwareResolver(parentPlan(), childPlan('shell_exec')),
    });

    const parentEvents = await collect(await harness.coordinator.send(root.id, 'Run it'));

    // YOLO does not wave a mandatory approval through, and it does not let the parent report a
    // completion it never reached: the parent turn is suspended on the child's approval.
    expect(parentEvents.map((event) => event.type)).toContain('tool-suspended');
    expect(parentEvents.some((event) => event.type === 'assistant-complete')).toBe(false);
    expect(harness.executions).toHaveLength(0);
    expect(harness.approvals.requests).toHaveLength(1);

    const approvalId = harness.approvals.requests[0].id;
    const suspended = await harness.coordinator.suspendedForApproval(approvalId);
    expect(suspended?.delegatedAgent?.approvalMode).toBe('yolo');
    const parentSuspension = await harness.coordinator.suspendedForAgent(root.id);
    expect(parentSuspension?.pending.kind).toBe('delegation');
  });

  /** Attack F: a stream that stops for approval is never reported as a completed delegation. */
  it('never reports completed while an approval is pending', async () => {
    const root = rootAgent();
    const harness = createIntegrationHarness({
      agents: [root],
      rules: [
        ...allowRules(root.id),
        { id: 'root-ask', agentId: root.id, toolId: ruleGatedToolId, decision: 'ask' },
      ],
      resolve: depthAwareResolver(
        parentPlan(),
        (toolResults) =>
          toolResults.length === 0
            ? [
                { text: 'Starting the configuration change. ' },
                { call: 'system_configure', input: { setting: 'enabled' } },
              ]
            : [{ text: 'Child done.' }],
      ),
    });

    const parentEvents = await collect(await harness.coordinator.send(root.id, 'Configure'));

    // The parent receives no tool result at all while the child waits, so it cannot report a
    // delegation outcome — completed or otherwise. Only a suspension is published.
    const toolComplete = parentEvents.find((event) => event.type === 'tool-complete');
    expect(toolComplete).toBeUndefined();
    const suspendedEvent = parentEvents.find((event) => event.type === 'tool-suspended') as
      | { suspension: { children: { childAgentId: string; approvalId?: string }[] } }
      | undefined;
    expect(suspendedEvent?.suspension.children[0].approvalId).toBe(
      harness.approvals.requests[0].id,
    );

    // The child's partial text is preserved on the child's own suspension, not fabricated into a
    // completed report for the parent.
    const child = await harness.coordinator.suspendedForApproval(harness.approvals.requests[0].id);
    expect(child?.pending.assistantText).toBe('Starting the configuration change. ');

    // The parent is suspended on the child, and its own approval lookup finds nothing to decide.
    const parentSuspension = await harness.coordinator.suspendedForAgent(root.id);
    expect(parentSuspension?.pending.kind).toBe('delegation');
    await expect(
      harness.coordinator.suspendedForApproval(harness.approvals.requests[0].id),
    ).resolves.toBe(child);

    // Approving finishes the whole chain, and the parent reports the child's real final answer.
    const resumeEvents = await collect(
      harness.coordinator.resolveApproval(harness.approvals.requests[0].id, 'approve'),
    );
    expect(resumeEvents.map((event) => event.type)).toContain('tool-complete');
    const parentCompletion = resumeEvents
      .filter((event) => event.type === 'assistant-complete')
      .at(-1) as { message: { content: string } };
    expect(parentCompletion.message.content).toContain('Child done.');
    expect(await harness.coordinator.suspendedForAgent(root.id)).toBeNull();
  });
});

describe('nested delegation depth through the real coordinator', () => {
  it('transports depth and chain through parent → child → grandchild', async () => {
    const root = rootAgent();
    const harness = createIntegrationHarness({
      agents: [root],
      rules: [
        ...allowRules(root.id),
        { id: 'root-ask', agentId: root.id, toolId: ruleGatedToolId, decision: 'ask' },
      ],
      resolve: async (agent) => {
        const depth = agent.delegationDepth ?? 0;
        return {
          provider: planProvider((toolResults) => {
            if (toolResults.length > 0) return [{ text: `depth ${depth} reported back` }];
            const plan =
              depth === 0
                ? [{ call: delegateCallName, input: { role: 'One', objective: 'a', instructions: 'b' } }]
                : depth === 1
                  ? [{ call: delegateCallName, input: { role: 'Two', objective: 'a', instructions: 'b' } }]
                  : [{ call: 'system_configure', input: { setting: 'enabled' } }];
            return plan;
          }),
          model: 'mock-model',
        };
      },
    });

    const events = await collect(await harness.coordinator.send(root.id, 'Dig deep'));
    expect(events.length).toBeGreaterThan(0);

    const child = harness.seen.find((entry) => entry.depth === 1)!;
    const grandchild = harness.seen.find((entry) => entry.depth === 2)!;
    expect(child.ancestors).toEqual([root.id]);
    expect(grandchild.ancestors).toEqual([child.agentId, root.id]);
    // The grandchild is at the default nesting limit, so it cannot open another agent.
    expect(harness.seen.some((entry) => entry.depth === 3)).toBe(false);

    // The grandchild's approval is suspended and resumable on its own.
    expect(harness.approvals.requests).toHaveLength(1);
    const suspended = await harness.coordinator.suspendedForApproval(
      harness.approvals.requests[0].id,
    );
    expect(suspended?.agentId).toBe(grandchild.agentId);
    expect(suspended?.delegationChain?.depth).toBe(2);
    expect(suspended?.delegationChain?.ancestors.map((ancestor) => ancestor.id)).toEqual([
      child.agentId,
      root.id,
    ]);
    expect(harness.executions).toHaveLength(0);
  });

  it('refuses to resume a delegated turn whose stored chain is missing', async () => {
    const root = rootAgent();
    const harness = createIntegrationHarness({
      agents: [root],
      rules: [
        ...allowRules(root.id),
        { id: 'root-ask', agentId: root.id, toolId: ruleGatedToolId, decision: 'ask' },
      ],
      resolve: depthAwareResolver(parentPlan(), childPlan()),
    });

    await collect(await harness.coordinator.send(root.id, 'Reconfigure now'));
    const suspended = harness.suspended.turns[0];
    expect(suspended).toBeDefined();

    // Corruption/tampering: a delegated record without its chain must fail closed, never resume as
    // a standalone agent that could ignore the parent's deny rules.
    harness.suspended.turns[0] = { ...suspended, delegationChain: undefined };

    if (suspended.pending.kind !== 'tool-approval') throw new Error('Expected an approval turn.');
    await expect(
      collect(harness.coordinator.resolveApproval(suspended.pending.approval.id, 'approve')),
    ).rejects.toThrow(/valid delegation chain/);
    expect(harness.executions).toHaveLength(0);
  });

  it('refuses to resume a delegated turn whose stored agent does not match the turn identity', async () => {
    const root = rootAgent();
    const harness = createIntegrationHarness({
      agents: [root],
      rules: [
        ...allowRules(root.id),
        { id: 'root-ask', agentId: root.id, toolId: ruleGatedToolId, decision: 'ask' },
      ],
      resolve: depthAwareResolver(parentPlan(), childPlan()),
    });

    await collect(await harness.coordinator.send(root.id, 'Reconfigure now'));
    const suspended = harness.suspended.turns[0];
    harness.suspended.turns[0] = {
      ...suspended,
      delegatedAgent: { ...suspended.delegatedAgent!, id: 'someone-else' },
    };

    if (suspended.pending.kind !== 'tool-approval') throw new Error('Expected an approval turn.');
    await expect(
      collect(harness.coordinator.resolveApproval(suspended.pending.approval.id, 'approve')),
    ).rejects.toThrow(/invalid agent definition/);
    expect(harness.executions).toHaveLength(0);
  });

  /**
   * Attack A, end to end: a roster agent whose definition claims a privileged ancestry cannot reach
   * that ancestor's allow rule. Before the fix, the mere presence of the field switched evaluation
   * onto the delegated path and turned the deny below into an allow.
   */
  it('grants no authority to a roster agent that claims a privileged ancestry', async () => {
    const root = rootAgent({
      toolIds: [ruleGatedToolId],
      inheritedPolicyAgentIds: ['privileged-agent'],
    });
    const harness = createIntegrationHarness({
      agents: [root],
      rules: [
        { id: 'privileged-allow', agentId: 'privileged-agent', toolId: ruleGatedToolId, decision: 'allow' },
      ],
      resolve: async () => ({
        provider: planProvider((toolResults) =>
          toolResults.length === 0
            ? [{ call: 'system_configure', input: { setting: 'enabled' } }]
            : [{ text: 'Direct turn done.' }],
        ),
        model: 'mock-model',
      }),
    });

    const events = await collect(await harness.coordinator.send(root.id, 'Configure'));

    expect(events.some((event) => event.type === 'tool-denied')).toBe(true);
    expect(harness.approvals.requests).toHaveLength(0);
    expect(harness.executions).toHaveLength(0);
    expect(harness.denials.join(' ')).toContain('No permission rule allows this tool');
  });

  it('keeps an unrelated direct approval flow working', async () => {    const root = rootAgent({ toolIds: [ruleGatedToolId] });
    const harness = createIntegrationHarness({
      agents: [root],
      rules: [{ id: 'root-ask', agentId: root.id, toolId: ruleGatedToolId, decision: 'ask' }],
      resolve: async () => ({
        provider: planProvider((toolResults) =>
          toolResults.length === 0
            ? [{ call: 'system_configure', input: { setting: 'enabled' } }]
            : [{ text: 'Direct turn done.' }],
        ),
        model: 'mock-model',
      }),
    });

    const events = await collect(await harness.coordinator.send(root.id, 'Configure'));
    const approvalId = harness.approvals.requests[0].id;
    expect(
      events.some((event) => event.type === 'tool-approval-required'),
    ).toBe(true);
    expect(delegateAllow).toEqual([]);

    const resumed = await collect(harness.coordinator.resolveApproval(approvalId, 'approve'));
    expect(resumed.map((event) => event.type)).toContain('tool-complete');
    expect(harness.executions).toEqual([{ setting: 'enabled' }]);
    expect(createDelegationContext({ depth: 0, ancestors: [] }).depth).toBe(0);
  });
});

/** Phase 2C.1: a delegated chain must never look finished while a descendant awaits approval. */
describe('nested suspension propagation (Phase 2C.1)', () => {
  /** root → child → grandchild, where the grandchild stops on an approval-required tool. */
  function threeLevelHarness() {
    const root = rootAgent();
    return {
      root,
      harness: createIntegrationHarness({
        agents: [root],
        rules: [
          ...allowRules(root.id),
          { id: 'root-ask', agentId: root.id, toolId: ruleGatedToolId, decision: 'ask' },
        ],
        resolve: async (agent) => {
          const depth = agent.delegationDepth ?? 0;
          return {
            provider: planProvider((toolResults) => {
              if (toolResults.length > 0) return [{ text: `depth ${depth} report: done` }];
              if (depth === 0)
                return [
                  {
                    call: delegateCallName,
                    input: { role: 'Child', objective: 'delegate deeper', instructions: 'go' },
                  },
                ];
              if (depth === 1)
                return [
                  {
                    call: delegateCallName,
                    input: { role: 'Grandchild', objective: 'configure', instructions: 'go' },
                  },
                ];
              return [{ call: 'system_configure', input: { setting: 'enabled' } }];
            }),
            model: 'mock-model',
          };
        },
      }),
    };
  }

  it('reports the root delegation as suspended, never completed, while a grandchild waits', async () => {
    const { root, harness } = threeLevelHarness();

    const events = await collect(await harness.coordinator.send(root.id, 'Do the work'));

    // BEFORE FIX this was: ["user-message","tool-call","tool-complete","assistant-chunk",
    // "assistant-complete"] — the root reported a completed delegation while the grandchild waited.
    expect(events.map((event) => event.type)).toEqual(['user-message', 'tool-call', 'tool-suspended']);
    expect(
      events.some(
        (event) => event.type === 'tool-complete' || event.type === 'assistant-complete',
      ),
    ).toBe(false);

    // The invariant: no ancestor is terminal while a descendant waits for approval.
    const turns = harness.suspended.turns;
    expect(turns).toHaveLength(3);
    const depths = turns.map((turn) => turn.delegatedAgent?.delegationDepth ?? 0).sort();
    expect(depths).toEqual([0, 1, 2]);
    const grandchild = turns.find((turn) => turn.delegatedAgent?.delegationDepth === 2);
    expect(grandchild?.pending.kind).toBe('tool-approval');
    const child = turns.find((turn) => turn.delegatedAgent?.delegationDepth === 1);
    const rootTurn = turns.find((turn) => turn.agentId === root.id);
    expect(child?.pending.kind).toBe('delegation');
    expect(rootTurn?.pending.kind).toBe('delegation');

    // Both ancestors wait on the grandchild's approval through the recorded child identity — never
    // on a heuristic.
    const approvalId = harness.approvals.requests[0].id;
    for (const [waiter, delegatedDepth] of [
      [child, 2],
      [rootTurn, 1],
    ] as const) {
      const waiting = waiter?.pending.kind === 'delegation' ? waiter.pending.waiting : [];
      const ref = waiting[0]?.children[0];
      expect(ref?.approvalId).toBe(approvalId);
      expect(ref?.ownerAgentId).toBe(grandchild?.agentId);
      expect(ref?.depth).toBe(delegatedDepth);
    }

    expect(harness.approvals.requests).toHaveLength(1);
    expect(harness.executions).toHaveLength(0);
  });

  /**
   * The full nested path §5 demands: approve the grandchild's approval once, and the whole chain
   * resumes bottom-up — grandchild finishes, the child that delegated to it finishes, and the root
   * finally reports a terminal result. No ancestor is left stranded as "suspended".
   */
  it('resumes the whole chain from the grandchild to the root on one approval', async () => {
    const { root, harness } = threeLevelHarness();
    await collect(await harness.coordinator.send(root.id, 'Do the work'));
    const approvalId = harness.approvals.requests[0].id;
    const grandchild = harness.suspended.turns.find(
      (turn) => turn.delegatedAgent?.delegationDepth === 2,
    );

    const resumeEvents = await collect(harness.coordinator.resolveApproval(approvalId, 'approve'));

    // The tool ran exactly once, and the whole chain reached a terminal state.
    expect(harness.executions).toEqual([{ setting: 'enabled' }]);
    expect(resumeEvents.filter((event) => event.type === 'tool-complete')).toHaveLength(3);
    const completions = resumeEvents.filter((event) => event.type === 'assistant-complete');
    expect(completions).toHaveLength(3);
    expect(
      (completions.at(-1) as { message: { content: string } }).message.content,
    ).toContain('depth 0 report: done');
    // Nothing is still suspended, and every level recorded what it actually did.
    expect(harness.suspended.turns).toHaveLength(0);
    expect(await harness.coordinator.suspendedForAgent(root.id)).toBeNull();
    const grandchildConversation = await harness.conversations.list(grandchild!.agentId);
    expect(grandchildConversation.at(-1)?.content).toContain('depth 2 report: done');

    // A second resolution cannot run anything again: the approval is already completed, and the
    // transcripts are not appended to a second time.
    const grandchildMessages = await harness.conversations.list(grandchild!.agentId);
    await expect(
      collect(harness.coordinator.resolveApproval(approvalId, 'approve')),
    ).rejects.toThrow(/No suspended agent turn matches/);
    expect(harness.executions).toEqual([{ setting: 'enabled' }]);
    expect(await harness.conversations.list(grandchild!.agentId)).toEqual(grandchildMessages);
    expect(harness.suspended.turns).toHaveLength(0);
  });

  /**
   * §19 adversarial: the delegated child is cancelled while its ancestors still wait. Resolving the
   * orphaned approval must not fabricate a result for either level.
   */
  it('stops the chain truthfully when the delegated child turn was cancelled', async () => {
    const { root, harness } = threeLevelHarness();
    await collect(await harness.coordinator.send(root.id, 'Do the work'));
    const approvalId = harness.approvals.requests[0].id;
    const grandchild = harness.suspended.turns.find(
      (turn) => turn.delegatedAgent?.delegationDepth === 2,
    );

    // A user cancels the suspended grandchild turn while the approval is still pending.
    await harness.coordinator.cancelSuspended(grandchild!.agentId);
    expect(harness.suspended.turns.some((turn) => turn.agentId === grandchild!.agentId)).toBe(false);

    await expect(
      collect(harness.coordinator.resolveApproval(approvalId, 'approve')),
    ).rejects.toThrow(/No suspended agent turn matches/);
    expect(harness.executions).toHaveLength(0);
    // The ancestors are still recorded as waiting — nothing claims they finished.
    const rootTurn = await harness.coordinator.suspendedForAgent(root.id);
    expect(rootTurn?.pending.kind).toBe('delegation');
  });

  /** §7: a denied nested approval is truthful at every level and executes nothing. */
  it('propagates a nested denial to every ancestor without executing the tool', async () => {
    const { root, harness } = threeLevelHarness();
    await collect(await harness.coordinator.send(root.id, 'Do the work'));
    const approvalId = harness.approvals.requests[0].id;

    const resumeEvents = await collect(harness.coordinator.resolveApproval(approvalId, 'deny'));

    expect(harness.executions).toHaveLength(0);
    expect(harness.approvals.requests[0].status).toBe('denied');
    expect(resumeEvents.map((event) => event.type)).toContain('tool-denied');
    // The grandchild still produced a report — about the denial — and every ancestor that waited on
    // it resumed and finished truthfully.
    expect(resumeEvents.filter((event) => event.type === 'assistant-complete')).toHaveLength(3);
    expect(harness.suspended.turns).toHaveLength(0);
    expect(await harness.coordinator.suspendedForAgent(root.id)).toBeNull();
  });
});

/** Phase 2C.1 §9: team delegation must propagate suspension exactly like a single delegation. */
describe('team delegation suspension propagation (Phase 2C.1)', () => {
  const teamTasks = [
    { role: 'Member A', objective: 'configure', instructions: 'go' },
    { role: 'Member B', objective: 'review', instructions: 'go' },
  ];

  /**
   * root → team → member A stops on an approval, while member B finishes. `teamDepth` selects
   * whether the team is called directly by the root or by a child agent in between.
   */
  function teamHarness(teamDepth: 0 | 1) {
    const root = rootAgent();
    const harness = createIntegrationHarness({
      agents: [root],
      rules: [
        ...allowRules(root.id),
        { id: 'root-ask', agentId: root.id, toolId: ruleGatedToolId, decision: 'ask' },
      ],
      resolve: async (agent) => {
        const depth = agent.delegationDepth ?? 0;
        const role = agent.name;
        return {
          provider: planProvider((toolResults) => {
            if (toolResults.length > 0) {
              return [{ text: `${role} report: ${toolResults.at(-1)!.content}` }];
            }
            if (depth === 0) {
              return teamDepth === 0
                ? [{ call: teamCallName, input: { tasks: teamTasks } }]
                : [
                    {
                      call: delegateCallName,
                      input: { role: 'Child', objective: 'run the team', instructions: 'go' },
                    },
                  ];
            }
            if (depth === teamDepth) return [{ call: teamCallName, input: { tasks: teamTasks } }];
            if (role === 'Member A') {
              return [{ call: 'system_configure', input: { setting: 'enabled' } }];
            }
            return [{ text: 'Member B report: nothing to reconfigure.' }];
          }),
          model: 'mock-model',
        };
      },
    });
    return { root, harness };
  }

  it('keeps the team and its parent suspended while one member waits, then resumes both', async () => {
    const { root, harness } = teamHarness(0);

    const events = await collect(await harness.coordinator.send(root.id, 'Run the team'));

    // The parent never sees a team result while a member is blocked.
    expect(events.map((event) => event.type)).toEqual(['user-message', 'tool-call', 'tool-suspended']);
    const approvalId = harness.approvals.requests[0].id;
    const memberA = harness.suspended.turns.find((turn) => turn.agentId !== root.id);
    expect(memberA?.pending.kind).toBe('tool-approval');
    expect(harness.suspended.turns).toHaveLength(2);

    // The parent's delegation wait names every member in request order; only the blocked one carries
    // the approval, and it points at the member that owns it.
    const rootTurn = harness.suspended.turns.find((turn) => turn.agentId === root.id);
    if (rootTurn?.pending.kind !== 'delegation') throw new Error('Expected a delegation wait.');
    const children = rootTurn.pending.waiting[0].children;
    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({
      approvalId,
      ownerAgentId: memberA!.agentId,
      depth: 1,
    });
    expect(children[1].approvalId).toBeUndefined();

    const resumeEvents = await collect(harness.coordinator.resolveApproval(approvalId, 'approve'));

    // One execution (member A's), and the whole chain — member A, the team, the root — is terminal.
    expect(harness.executions).toEqual([{ setting: 'enabled' }]);
    expect(harness.suspended.turns).toHaveLength(0);
    expect(await harness.coordinator.suspendedForAgent(root.id)).toBeNull();
    const rootCompletion = resumeEvents
      .filter((event) => event.type === 'assistant-complete')
      .at(-1) as { message: { content: string } };
    // The team result reports member A's recorded answer and member B's, and is not re-run.
    expect(rootCompletion.message.content).toContain('Member A report: ');
    expect(rootCompletion.message.content).toContain('configured');
    expect(rootCompletion.message.content).toContain('Member B report: nothing to reconfigure.');
    expect(rootCompletion.message.content).toContain('"status":"completed"');
    expect(harness.executions).toHaveLength(1);
  });

  it('propagates a member approval through a child agent and a team to the root', async () => {
    const { root, harness } = teamHarness(1);

    const events = await collect(await harness.coordinator.send(root.id, 'Run the team deeper'));

    // root (depth 0) → child (depth 1) → member (depth 2): all three are suspended, none terminal.
    expect(events.some((event) => event.type === 'assistant-complete')).toBe(false);
    expect(events.map((event) => event.type)).toContain('tool-suspended');
    expect(harness.suspended.turns).toHaveLength(3);
    expect(
      harness.suspended.turns
        .map((turn) => turn.delegatedAgent?.delegationDepth ?? 0)
        .sort(),
    ).toEqual([0, 1, 2]);
    expect(harness.approvals.requests).toHaveLength(1);
    expect(harness.executions).toHaveLength(0);

    const approvalId = harness.approvals.requests[0].id;
    const owner = await harness.coordinator.suspendedForApproval(approvalId);
    expect(owner?.delegatedAgent?.delegationDepth).toBe(2);

    const resumeEvents = await collect(harness.coordinator.resolveApproval(approvalId, 'approve'));

    expect(harness.executions).toEqual([{ setting: 'enabled' }]);
    expect(harness.suspended.turns).toHaveLength(0);
    expect(await harness.coordinator.suspendedForAgent(root.id)).toBeNull();
    // Three levels resumed: member, child, root — each with its own terminal message.
    expect(resumeEvents.filter((event) => event.type === 'assistant-complete')).toHaveLength(3);
    const rootCompletion = resumeEvents
      .filter((event) => event.type === 'assistant-complete')
      .at(-1) as { message: { content: string } };
    expect(rootCompletion.message.content).toContain('root report');
  });
});
