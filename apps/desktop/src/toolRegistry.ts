import { ToolRegistry } from '@iris/tools';

// Lightweight shared identity: configuration validates against the same registry used for execution.
// Registration remains in tooling/agentRuntime; importing persistence must not initialize tools.
export const toolRegistry = new ToolRegistry();
