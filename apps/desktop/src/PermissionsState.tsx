import { useEffect, useState } from 'react';
import type { AgentDefinition } from '@iris/core';
import {
  AuditedPermissionEngine,
  StaticPermissionEngine,
  setToolAssigned,
  type PermissionAuditEvent,
  type PermissionDecision,
  type PermissionEvaluation,
  type PermissionRule,
  type ToolApprovalRequest,
  type ToolDefinition,
} from '@iris/tools';
import {
  agentRepository,
  permissionAuditRepository,
  permissionRuleRepository,
  toolApprovalRepository,
} from './persistence';
import { agentRuntime, consumeAgentEvents, subscribeAgentRuntime } from './agentRuntime';
import { projectWorkflowRuntime, subscribeProjectRuntime } from './projectRuntime';
import { createToolExecutor, toolRegistry } from './tooling';
import { subscribeMcpServers } from './mcp';
import { agentToolRuleId } from './agentPermissions';

function decisionLabel(decision: PermissionDecision): string {
  if (decision === 'ask') return 'Ask every time';
  return decision[0].toUpperCase() + decision.slice(1);
}

function outputSummary(output: unknown): string {
  if (output && typeof output === 'object') {
    const value = output as Record<string, unknown>;
    if (value.saved === true && typeof value.memoryId === 'string') {
      return `Saved as local memory ${value.memoryId}.`;
    }
    if (
      typeof value.operatingSystem === 'string' &&
      typeof value.architecture === 'string' &&
      typeof value.appVersion === 'string'
    ) {
      return `IRIS ${value.appVersion} · ${value.operatingSystem} · ${value.architecture}`;
    }
  }
  return 'Tool completed successfully.';
}

function AuditRow({ event }: { event: PermissionAuditEvent }) {
  return (
    <li className="audit-row">
      <span className={`decision-mark decision-${event.decision}`} aria-hidden="true" />
      <span className="audit-copy">
        <strong>
          {event.agentName} · {event.toolName}
        </strong>
        <small>{event.reason}</small>
      </span>
      <span className="audit-meta">
        {event.source}
        <time dateTime={event.timestamp}>
          {new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
          }).format(new Date(event.timestamp))}
        </time>
      </span>
    </li>
  );
}

function ToolPolicyRow({
  agent,
  tool,
  rule,
  evaluation,
  onAssignmentChange,
  onDecisionChange,
  onInspect,
  onRun,
  running,
  executionMessage,
}: {
  agent: AgentDefinition;
  tool: ToolDefinition;
  rule?: PermissionRule;
  evaluation?: PermissionEvaluation;
  onAssignmentChange: (assigned: boolean) => Promise<void>;
  onDecisionChange: (decision: PermissionDecision | '') => Promise<void>;
  onInspect: () => Promise<void>;
  onRun: () => Promise<void>;
  running: boolean;
  executionMessage?: string;
}) {
  const assigned = agent.toolIds.includes(tool.id);
  return (
    <article className="tool-policy-row">
      <button
        className={`assignment-toggle ${assigned ? 'assigned' : ''}`}
        aria-pressed={assigned}
        aria-label={`${assigned ? 'Unassign' : 'Assign'} ${tool.name}`}
        onClick={() => void onAssignmentChange(!assigned)}
      >
        <span />
      </button>
      <div className="tool-policy-copy">
        <div>
          <strong>{tool.name}</strong>
          <span className={`risk-label risk-${tool.risk}`}>{tool.risk}</span>
        </div>
        <small>{tool.description}</small>
      </div>
      <label className="policy-select">
        Explicit policy
        <select
          value={rule?.decision ?? ''}
          onChange={(event) => void onDecisionChange(event.target.value as PermissionDecision | '')}
        >
          <option value="">No rule · deny</option>
          <option value="ask">Ask every time</option>
          <option value="allow">Allow</option>
          <option value="deny">Deny</option>
        </select>
      </label>
      <div className="policy-result">
        {evaluation ? (
          <>
            <span className={`decision-badge decision-${evaluation.decision}`}>
              {decisionLabel(evaluation.decision)}
            </span>
            <small>{evaluation.reason}</small>
          </>
        ) : (
          <small>Inspect to resolve assignment and policy together.</small>
        )}
        {executionMessage && <small className="tool-execution-message">{executionMessage}</small>}
      </div>
      <div className="tool-row-actions">
        <button className="row-button" onClick={() => void onInspect()}>
          Inspect
        </button>
        <button
          className="row-button run-tool-button"
          disabled={running || tool.manualExecution === false}
          onClick={() => void onRun()}
          title={
            tool.manualExecution === false
              ? 'This tool requires provenance from a real agent turn.'
              : undefined
          }
        >
          {tool.manualExecution === false ? 'Agent only' : running ? 'Running…' : 'Run'}
        </button>
      </div>
    </article>
  );
}

function ApprovalRow({
  approval,
  busy,
  onResolve,
  onResume,
}: {
  approval: ToolApprovalRequest;
  busy: boolean;
  onResolve: (decision: 'approve' | 'deny') => Promise<void>;
  onResume: () => Promise<void>;
}) {
  return (
    <li className="approval-row">
      <span className={`approval-status approval-${approval.status}`}>{approval.status}</span>
      <span className="approval-copy">
        <strong>
          {approval.agentName} · {approval.toolName}
        </strong>
        <small>{approval.evaluation.reason}</small>
      </span>
      <time dateTime={approval.createdAt}>
        {new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
          new Date(approval.createdAt),
        )}
      </time>
      {approval.status === 'pending' ? (
        <span className="approval-actions">
          <button className="row-button" disabled={busy} onClick={() => void onResolve('deny')}>
            Deny
          </button>
          <button
            className="row-button approval-button"
            disabled={busy}
            onClick={() => void onResolve('approve')}
          >
            Approve & run
          </button>
        </span>
      ) : approval.status === 'approved' ? (
        <button
          className="row-button approval-button"
          disabled={busy}
          onClick={() => void onResume()}
        >
          Run approved
        </button>
      ) : (
        <span className="approval-outcome">{approval.error ?? approval.status}</span>
      )}
    </li>
  );
}

export function PermissionsState() {
  const [tools, setTools] = useState(() => toolRegistry.list());
  useEffect(() => subscribeMcpServers(() => setTools(toolRegistry.list())), []);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [audit, setAudit] = useState<PermissionAuditEvent[]>([]);
  const [approvals, setApprovals] = useState<ToolApprovalRequest[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [evaluations, setEvaluations] = useState<Record<string, PermissionEvaluation>>({});
  const [executionMessages, setExecutionMessages] = useState<Record<string, string>>({});
  const [runningToolId, setRunningToolId] = useState<string | null>(null);
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      agentRepository.list(),
      permissionRuleRepository.list(),
      permissionAuditRepository.list(),
      toolApprovalRepository.list(),
    ]).then(([storedAgents, storedRules, storedAudit, storedApprovals]) => {
      if (!active) return;
      setAgents(storedAgents);
      setRules(storedRules);
      setAudit(storedAudit);
      setApprovals(storedApprovals);
      setSelectedAgentId(storedAgents[0]?.id ?? null);
      setLoaded(true);
    });
    const unsubscribeAgent = subscribeAgentRuntime(() => {
      void refreshExecutionState();
    });
    const unsubscribeProject = subscribeProjectRuntime(() => {
      void refreshExecutionState();
    });
    return () => {
      active = false;
      unsubscribeAgent();
      unsubscribeProject();
    };
  }, []);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const activeApprovalCount = approvals.filter(
    (approval) => ['pending', 'approved', 'executing'].includes(approval.status),
  ).length;

  function createExecutor() {
    return createToolExecutor(rules);
  }

  async function refreshExecutionState() {
    const [storedAgents, storedRules, storedAudit, storedApprovals] = await Promise.all([
      agentRepository.list(),
      permissionRuleRepository.list(),
      permissionAuditRepository.list(),
      toolApprovalRepository.list(),
    ]);
    setAgents(storedAgents);
    setRules(storedRules);
    setSelectedAgentId((current) =>
      storedAgents.some((agent) => agent.id === current) ? current : (storedAgents[0]?.id ?? null),
    );
    setAudit(storedAudit);
    setApprovals(storedApprovals);
  }

  async function changeAssignment(tool: ToolDefinition, assigned: boolean) {
    if (!selectedAgent) return;
    const updated = setToolAssigned(selectedAgent, tool, assigned);
    await agentRepository.save(updated);
    const id = agentToolRuleId(selectedAgent.id, tool.id);
    const existingRule = rules.find((rule) => rule.id === id);
    if (assigned && !existingRule) {
      const rule: PermissionRule = {
        id,
        agentId: selectedAgent.id,
        toolId: tool.id,
        decision: 'ask',
        reason: `${selectedAgent.name} requires approval each time it requests ${tool.name}.`,
      };
      await permissionRuleRepository.save(rule);
      setRules((current) => [...current.filter((item) => item.id !== id), rule]);
    } else if (!assigned && existingRule) {
      await permissionRuleRepository.remove(id);
      setRules((current) => current.filter((rule) => rule.id !== id));
    }
    setAgents((current) => current.map((agent) => (agent.id === updated.id ? updated : agent)));
    try {
      agentRuntime.refreshConfiguration(updated.id);
      setExecutionMessages((current) => ({
        ...current,
        [tool.id]: assigned
          ? 'Assignment saved for the next agent turn.'
          : 'Assignment removed for the next agent turn.',
      }));
    } catch {
      setExecutionMessages((current) => ({
        ...current,
        [tool.id]: 'Assignment saved. Start a new session after the current run finishes.',
      }));
    }
    setEvaluations((current) => {
      const next = { ...current };
      delete next[tool.id];
      return next;
    });
  }

  async function changeDecision(tool: ToolDefinition, decision: PermissionDecision | '') {
    if (!selectedAgent) return;
    const id = agentToolRuleId(selectedAgent.id, tool.id);
    if (!decision) {
      await permissionRuleRepository.remove(id);
      setRules((current) => current.filter((rule) => rule.id !== id));
    } else {
      const rule: PermissionRule = {
        id,
        agentId: selectedAgent.id,
        toolId: tool.id,
        decision,
      };
      await permissionRuleRepository.save(rule);
      setRules((current) => [...current.filter((item) => item.id !== id), rule]);
    }
    setEvaluations((current) => {
      const next = { ...current };
      delete next[tool.id];
      return next;
    });
  }

  async function inspect(tool: ToolDefinition) {
    if (!selectedAgent) return;
    const permissions = new AuditedPermissionEngine(
      new StaticPermissionEngine(rules),
      permissionAuditRepository,
    );
    const evaluation = await permissions.evaluate(selectedAgent, tool, { source: 'inspection' });
    setEvaluations((current) => ({ ...current, [tool.id]: evaluation }));
    setAudit(await permissionAuditRepository.list());
  }

  async function runTool(tool: ToolDefinition) {
    if (!selectedAgent || tool.manualExecution === false) return;
    setRunningToolId(tool.id);
    setExecutionMessages((current) => ({ ...current, [tool.id]: '' }));
    try {
      const result = await createExecutor().execute(selectedAgent, tool.id, {});
      setExecutionMessages((current) => ({
        ...current,
        [tool.id]:
          result.status === 'approval-required'
            ? 'Approval requested. Resolve it below.'
            : outputSummary(result.output),
      }));
    } catch (error) {
      setExecutionMessages((current) => ({
        ...current,
        [tool.id]: error instanceof Error ? error.message : 'Tool execution failed.',
      }));
    } finally {
      await refreshExecutionState();
      setRunningToolId(null);
    }
  }

  async function resolveApproval(approval: ToolApprovalRequest, decision: 'approve' | 'deny') {
    setBusyApprovalId(approval.id);
    try {
      const suspended = await agentRuntime.suspendedForApproval(approval.id);
      if (suspended) {
        await consumeAgentEvents(agentRuntime.resolveApproval(approval.id, decision));
        setExecutionMessages((current) => ({
          ...current,
          [approval.toolId]: 'Agent turn continued and its conversation was saved.',
        }));
        return;
      }
      const projectRun = await projectWorkflowRuntime.suspendedForApproval(approval.id);
      if (projectRun) {
        await projectWorkflowRuntime.resolveApproval(approval.id, decision);
        setExecutionMessages((current) => ({
          ...current,
          [approval.toolId]: 'Project worker continued and its task run was saved.',
        }));
        return;
      }
      const result = await createExecutor().resolve(approval.id, decision);
      setExecutionMessages((current) => ({
        ...current,
        [approval.toolId]:
          result.status === 'completed'
            ? outputSummary(result.output)
            : 'This invocation was denied and did not run.',
      }));
    } catch (error) {
      setExecutionMessages((current) => ({
        ...current,
        [approval.toolId]: error instanceof Error ? error.message : 'Approval resolution failed.',
      }));
    } finally {
      await refreshExecutionState();
      setBusyApprovalId(null);
    }
  }

  async function resumeApproval(approval: ToolApprovalRequest) {
    setBusyApprovalId(approval.id);
    try {
      const suspended = await agentRuntime.suspendedForApproval(approval.id);
      if (suspended) {
        await consumeAgentEvents(agentRuntime.resolveApproval(approval.id, 'approve'));
        setExecutionMessages((current) => ({
          ...current,
          [approval.toolId]: 'Approved agent turn continued and its conversation was saved.',
        }));
        return;
      }
      const projectRun = await projectWorkflowRuntime.suspendedForApproval(approval.id);
      if (projectRun) {
        await projectWorkflowRuntime.resolveApproval(approval.id, 'approve');
        setExecutionMessages((current) => ({
          ...current,
          [approval.toolId]: 'Approved project worker continued and its task run was saved.',
        }));
        return;
      }
      const result = await createExecutor().resume(approval.id);
      if (result.status === 'completed') {
        setExecutionMessages((current) => ({
          ...current,
          [approval.toolId]: outputSummary(result.output),
        }));
      }
    } catch (error) {
      setExecutionMessages((current) => ({
        ...current,
        [approval.toolId]: error instanceof Error ? error.message : 'Approved tool failed.',
      }));
    } finally {
      await refreshExecutionState();
      setBusyApprovalId(null);
    }
  }

  async function clearAudit() {
    await permissionAuditRepository.clear();
    setAudit([]);
  }

  async function clearResolvedApprovals() {
    await toolApprovalRepository.clearResolved();
    setApprovals(await toolApprovalRepository.list());
  }

  return (
    <div className="permissions-state">
      <div className="permissions-heading">
        <div>
          <p className="eyebrow">Permission studio</p>
          <h2>Authority stays visible.</h2>
          <p>
            Tool assignment and policy are separate. Every resolved decision is written to the local
            audit stream before execution can proceed.
          </p>
        </div>
        <span className="security-seal">Deny by default</span>
      </div>

      <div className="permission-facts" aria-label="Permission status">
        <div>
          <strong>{tools.length}</strong>
          <span>registered tools</span>
        </div>
        <div>
          <strong>{rules.length}</strong>
          <span>explicit policies</span>
        </div>
        <div>
          <strong>{audit.length}</strong>
          <span>recorded decisions</span>
        </div>
        <div>
          <strong>{activeApprovalCount}</strong>
          <span>active approvals</span>
        </div>
      </div>

      {!loaded ? (
        <div className="permission-empty">Loading permission state…</div>
      ) : agents.length === 0 ? (
        <div className="permission-empty">
          <strong>No agents to configure</strong>
          <p>Create an agent first. IRIS never grants tools globally by implication.</p>
        </div>
      ) : (
        <div className="permission-workbench">
          <aside className="permission-agents">
            <p className="section-label">Agent</p>
            {agents.map((agent) => (
              <button
                key={agent.id}
                className={agent.id === selectedAgentId ? 'selected' : ''}
                onClick={() => {
                  setSelectedAgentId(agent.id);
                  setEvaluations({});
                }}
              >
                <span className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</span>
                <span>
                  <strong>{agent.name}</strong>
                  <small>{agent.toolIds.length} assigned</small>
                </span>
              </button>
            ))}
          </aside>

          <section className="tool-access-panel">
            <div className="section-heading">
              <div>
                <p className="section-label">Tool access</p>
                <h3>{selectedAgent?.name}</h3>
              </div>
              <span>{selectedAgent?.autonomy} autonomy</span>
            </div>
            {tools.length === 0 ? (
              <div className="registered-tools-empty">
                <span>○</span>
                <div>
                  <strong>No tools are registered</strong>
                  <p>
                    Assignment controls will appear when a real tool adapter is installed. No
                    placeholder capabilities are shown.
                  </p>
                </div>
              </div>
            ) : (
              <div className="tool-policy-list">
                {tools.map((tool) => (
                  <ToolPolicyRow
                    key={tool.id}
                    agent={selectedAgent!}
                    tool={tool}
                    rule={rules.find(
                      (rule) => rule.agentId === selectedAgentId && rule.toolId === tool.id,
                    )}
                    evaluation={evaluations[tool.id]}
                    onAssignmentChange={(assigned) => changeAssignment(tool, assigned)}
                    onDecisionChange={(decision) => changeDecision(tool, decision)}
                    onInspect={() => inspect(tool)}
                    onRun={() => runTool(tool)}
                    running={runningToolId === tool.id}
                    executionMessage={executionMessages[tool.id]}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      <section className="approval-panel">
        <div className="section-heading">
          <div>
            <p className="section-label">Approval queue</p>
            <h3>Specific tool invocations</h3>
          </div>
          {approvals.some(
            (approval) => !['pending', 'approved', 'executing'].includes(approval.status),
          ) && (
            <button className="row-button" onClick={() => void clearResolvedApprovals()}>
              Clear resolved
            </button>
          )}
        </div>
        {approvals.length === 0 ? (
          <div className="approval-empty">
            No approval requests. Tools with an “Ask every time” policy will create one before they
            can run.
          </div>
        ) : (
          <ul className="approval-list">
            {approvals.map((approval) => (
              <ApprovalRow
                key={approval.id}
                approval={approval}
                busy={busyApprovalId === approval.id}
                onResolve={(decision) => resolveApproval(approval, decision)}
                onResume={() => resumeApproval(approval)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="audit-panel">
        <div className="section-heading">
          <div>
            <p className="section-label">Local audit stream</p>
            <h3>Permission decisions</h3>
          </div>
          {audit.length > 0 && (
            <button className="row-button" onClick={() => void clearAudit()}>
              Clear audit
            </button>
          )}
        </div>
        {audit.length === 0 ? (
          <div className="audit-empty">
            No decisions recorded yet. Inspection and future execution checks will appear here.
          </div>
        ) : (
          <ul className="audit-list">
            {audit.map((event) => (
              <AuditRow key={event.id} event={event} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
