import type { AgentDefinition } from '@iris/core';
import type { AgentProviderResolver, AgentRepository, AgentToolRuntime } from '@iris/agents';
import { AgentSession } from '@iris/agents';
import type { RegisteredTool, ToolContext } from '@iris/tools';

export const subAgentToolId = 'cortex.delegate-subagent';
export const subAgentTeamToolId = 'cortex.delegate-team';

export interface SubAgentToolInput {
  role: string;
  objective: string;
  instructions: string;
  model?: string;
  _depth?: number;
}

export interface SubAgentTeamInput {
  tasks: SubAgentToolInput[];
  _depth?: number;
}

export interface SubAgentToolOutput {
  status: 'completed' | 'failed';
  role: string;
  objective: string;
  toolsUsed: string[];
  output: string;
}

export interface SubAgentTeamOutput {
  status: 'completed' | 'partial' | 'failed';
  results: SubAgentToolOutput[];
}

export interface SubAgentToolOptions {
  agentRepository: AgentRepository;
  providerResolver: AgentProviderResolver;
  agentToolRuntime: AgentToolRuntime;
  maxRecursionDepth?: number;
}

const MAX_TEAM_SIZE = 4;

export function validateSubAgentInput(input: unknown): input is SubAgentToolInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return (
    typeof value.role === 'string' &&
    Boolean(value.role.trim()) &&
    typeof value.objective === 'string' &&
    Boolean(value.objective.trim()) &&
    typeof value.instructions === 'string' &&
    Boolean(value.instructions.trim()) &&
    (value.model === undefined || typeof value.model === 'string') &&
    (value._depth === undefined || typeof value._depth === 'number')
  );
}

export function validateSubAgentTeamInput(input: unknown): input is SubAgentTeamInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) return false;
  return value.tasks.every(validateSubAgentInput);
}

interface RunSubAgentContext {
  agentId: string;
  agentName: string;
  signal?: AbortSignal;
}

/**
 * Builds an ephemeral specialist AgentDefinition and runs one focused session to
 * completion. Shared by the single-delegation and parallel-team tools so both get
 * identical depth guards, tool scoping and output shaping.
 */
async function runSubAgent(
  options: SubAgentToolOptions,
  parentAgent: AgentDefinition,
  task: SubAgentToolInput,
  depth: number,
  maxDepth: number,
  context: RunSubAgentContext,
): Promise<SubAgentToolOutput> {
  const role = task.role.trim();
  const objective = task.objective.trim();
  const base = { role, objective };

  if (depth > maxDepth) {
    return {
      ...base,
      status: 'failed',
      toolsUsed: [],
      output: `Sub-agent recursion depth limit exceeded (maximum allowed depth is ${maxDepth}).`,
    };
  }

  // Ephemeral sub-agent definition scoped for this delegation task
  const subAgent: AgentDefinition = {
    id: `subagent-${crypto.randomUUID()}`,
    name: role,
    providerPolicyId: parentAgent.providerPolicyId,
    model: task.model?.trim() || parentAgent.model,
    persona: `You are an autonomous specialist sub-agent working as "${role}". Your objective is: "${objective}". Solve this task thoroughly using your available tools, and conclude with a clear, concise, verified summary of your findings and results.`,
    autonomy: parentAgent.autonomy,
    approvalMode: 'yolo', // Inherit auto-execution for tools within the sub-agent sandbox
    toolIds: parentAgent.toolIds.filter((id) => id !== subAgentToolId || depth < maxDepth),
    skillIds: [...parentAgent.skillIds],
  };

  try {
    const { provider, model } = await options.providerResolver.resolve(subAgent);
    const session = new AgentSession(subAgent, provider, model, [], options.agentToolRuntime);

    const prompt = `Specialist Assignment: ${role}\nObjective: ${objective}\n\nDetailed Instructions:\n${task.instructions.trim()}\n\nPlease execute your task using your tools and return your final report.`;

    const events = session.send(prompt, context.signal);
    let output = '';
    const toolsUsed: string[] = [];

    for await (const event of events) {
      if (event.type === 'tool-call') {
        toolsUsed.push(event.call.name);
      }
      if (event.type === 'assistant-chunk') {
        output += event.text;
      }
      if (event.type === 'assistant-complete') {
        if (event.message.content) {
          output = event.message.content;
        }
      }
    }

    return {
      ...base,
      status: 'completed',
      toolsUsed: [...new Set(toolsUsed)],
      output: output || 'Sub-agent completed without returning text output.',
    } satisfies SubAgentToolOutput;
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      toolsUsed: [],
      output:
        error instanceof Error && error.message.trim()
          ? `Sub-agent failed: ${error.message}`
          : 'Sub-agent failed without returning a reason.',
    } satisfies SubAgentToolOutput;
  }
}

async function resolveParentAgent(
  options: SubAgentToolOptions,
  context: ToolContext,
): Promise<AgentDefinition> {
  return (
    (await options.agentRepository.get(context.agentId)) ?? {
      id: context.agentId,
      name: context.agentName,
      autonomy: 'assist' as const,
      toolIds: [],
      skillIds: [],
    }
  );
}

export function createSubAgentTool(options: SubAgentToolOptions): RegisteredTool {
  const maxDepth = options.maxRecursionDepth ?? 2;

  return {
    id: subAgentToolId,
    name: 'cortex_delegate_subagent',
    providerName: 'cortex_delegate_subagent',
    description:
      'Delegate a specialized sub-task to an autonomous specialist sub-agent (e.g. "Code Reviewer", "Deep Researcher", "System Diagnostician", "Workspace Explorer") that runs in its own focused execution context and returns a verified summary of its results.',
    risk: 'execute',
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description:
            'The specialized role of the sub-agent (e.g. "Code Reviewer", "Workspace Researcher", "System Diagnostician", "Architecture Critic").',
        },
        objective: {
          type: 'string',
          description: 'The primary goal or question the sub-agent must solve.',
        },
        instructions: {
          type: 'string',
          description: 'Detailed instructions, context, constraints, and steps for the sub-agent.',
        },
        model: {
          type: 'string',
          description: 'Optional model override for the sub-agent (defaults to parent agent model).',
        },
      },
      required: ['role', 'objective', 'instructions'],
    },
    async run(input: unknown, context: ToolContext): Promise<unknown> {
      if (!validateSubAgentInput(input)) {
        throw new Error(
          'cortex_delegate_subagent requires "role", "objective", and "instructions" as non-empty text.',
        );
      }

      const parentAgent = await resolveParentAgent(options, context);
      const depth = (input._depth ?? 0) + 1;
      return runSubAgent(options, parentAgent, input, depth, maxDepth, {
        agentId: context.agentId,
        agentName: context.agentName,
        signal: context.signal,
      });
    },
  };
}

export function createSubAgentTeamTool(options: SubAgentToolOptions): RegisteredTool {
  const maxDepth = options.maxRecursionDepth ?? 2;

  return {
    id: subAgentTeamToolId,
    name: 'cortex_delegate_team',
    providerName: 'cortex_delegate_team',
    description:
      'Fan a task out to a team of 1-4 specialist sub-agents that run in parallel and return individual reports. Use this when several independent perspectives or work streams are needed at once (e.g. a researcher, a reviewer and a tester working simultaneously). Each member inherits the parent agent\'s tools and model unless overridden per task.',
    risk: 'execute',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_TEAM_SIZE,
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', description: 'Specialist role, e.g. "Security Reviewer".' },
              objective: { type: 'string', description: 'The goal this member must solve.' },
              instructions: {
                type: 'string',
                description: 'Detailed instructions, context, constraints, and steps.',
              },
              model: {
                type: 'string',
                description: 'Optional model override for this member.',
              },
            },
            required: ['role', 'objective', 'instructions'],
            additionalProperties: false,
          },
          description: `The team members to run in parallel (1-${MAX_TEAM_SIZE}).`,
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
    async run(input: unknown, context: ToolContext): Promise<unknown> {
      if (!validateSubAgentTeamInput(input)) {
        throw new Error(
          'cortex_delegate_team requires "tasks": a non-empty array (max ' +
            `${MAX_TEAM_SIZE}) of {role, objective, instructions} objects.`,
        );
      }
      if (input.tasks.length > MAX_TEAM_SIZE) {
        throw new Error(
          `cortex_delegate_team runs at most ${MAX_TEAM_SIZE} members in parallel.`,
        );
      }

      const parentAgent = await resolveParentAgent(options, context);
      const depth = (input._depth ?? 0) + 1;
      const runContext: RunSubAgentContext = {
        agentId: context.agentId,
        agentName: context.agentName,
        signal: context.signal,
      };

      const results = await Promise.all(
        input.tasks.map((task) =>
          runSubAgent(options, parentAgent, task, depth, maxDepth, runContext),
        ),
      );

      const failed = results.filter((result) => result.status === 'failed').length;
      return {
        status: failed === results.length ? 'failed' : failed > 0 ? 'partial' : 'completed',
        results,
      } satisfies SubAgentTeamOutput;
    },
  };
}
