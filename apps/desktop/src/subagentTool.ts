import type { AgentDefinition } from '@iris/core';
import type { AgentProviderResolver, AgentRepository, AgentToolRuntime } from '@iris/agents';
import { AgentSession } from '@iris/agents';
import type { RegisteredTool, ToolContext } from '@iris/tools';

export const subAgentToolId = 'cortex.delegate-subagent';

export interface SubAgentToolInput {
  role: string;
  objective: string;
  instructions: string;
  model?: string;
  _depth?: number;
}

export interface SubAgentToolOutput {
  status: 'completed' | 'failed';
  role: string;
  objective: string;
  toolsUsed: string[];
  output: string;
}

export interface SubAgentToolOptions {
  agentRepository: AgentRepository;
  providerResolver: AgentProviderResolver;
  agentToolRuntime: AgentToolRuntime;
  maxRecursionDepth?: number;
}

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

      const parentAgent = (await options.agentRepository.get(context.agentId)) ?? {
        id: context.agentId,
        name: context.agentName,
        autonomy: 'assist' as const,
        toolIds: [],
        skillIds: [],
      };

      const currentDepth = (input._depth ?? 0) + 1;
      if (currentDepth > maxDepth) {
        return {
          status: 'failed',
          role: input.role.trim(),
          objective: input.objective.trim(),
          toolsUsed: [],
          output: `Sub-agent recursion depth limit exceeded (maximum allowed depth is ${maxDepth}).`,
        } satisfies SubAgentToolOutput;
      }

      // Ephemeral sub-agent definition scoped for this delegation task
      const subAgent: AgentDefinition = {
        id: `subagent-${crypto.randomUUID()}`,
        name: `${input.role.trim()}`,
        providerPolicyId: parentAgent.providerPolicyId,
        model: input.model?.trim() || parentAgent.model,
        persona: `You are an autonomous specialist sub-agent working as "${input.role.trim()}". Your objective is: "${input.objective.trim()}". Solve this task thoroughly using your available tools, and conclude with a clear, concise, verified summary of your findings and results.`,
        autonomy: parentAgent.autonomy,
        approvalMode: 'yolo', // Inherit auto-execution for tools within the sub-agent sandbox
        toolIds: parentAgent.toolIds.filter((id) => id !== subAgentToolId || currentDepth < maxDepth),
        skillIds: [...parentAgent.skillIds],
      };

      const { provider, model } = await options.providerResolver.resolve(subAgent);
      const session = new AgentSession(subAgent, provider, model, [], options.agentToolRuntime);

      const prompt = `Specialist Assignment: ${input.role.trim()}\nObjective: ${input.objective.trim()}\n\nDetailed Instructions:\n${input.instructions.trim()}\n\nPlease execute your task using your tools and return your final report.`;

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
        status: 'completed',
        role: input.role.trim(),
        objective: input.objective.trim(),
        toolsUsed: [...new Set(toolsUsed)],
        output: output || 'Sub-agent completed without returning text output.',
      } satisfies SubAgentToolOutput;
    },
  };
}
