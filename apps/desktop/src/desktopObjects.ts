import type { IrisObjectType } from '@iris/core';
import {
  AgentsIcon,
  ChannelsIcon,
  ConnectionsIcon,
  GitHubIcon,
  MemoryIcon,
  ModelsIcon,
  ProjectsIcon,
  SchedulesIcon,
  SkillsIcon,
  SubtitlesIcon,
  SystemIcon,
  WorkspaceIcon,
} from './icons';
export const objects: Array<{
  type: IrisObjectType;
  label: string;
  description: string;
  Icon: typeof AgentsIcon;
}> = [
  {
    type: 'agents',
    label: 'Agents',
    description: 'Create and configure autonomous workers.',
    Icon: AgentsIcon,
  },
  {
    type: 'projects',
    label: 'Projects',
    description: 'Shape durable task graphs and their prerequisites.',
    Icon: ProjectsIcon,
  },
  {
    type: 'schedules',
    label: 'Schedules',
    description: 'Plan agent runs with local, inspectable timing.',
    Icon: SchedulesIcon,
  },
  {
    type: 'workspace',
    label: 'Workspace',
    description: 'Mount and inspect one real local folder.',
    Icon: WorkspaceIcon,
  },
  {
    type: 'github',
    label: 'GitHub',
    description: 'Autonomous versioning, release automation & intelligent debugging.',
    Icon: GitHubIcon,
  },
  {
    type: 'models',
    label: 'Models',
    description: 'Connect local and cloud model providers.',
    Icon: ModelsIcon,
  },
  {
    type: 'memory',
    label: 'Memory',
    description: 'Inspect what the system remembers and why.',
    Icon: MemoryIcon,
  },
  {
    type: 'skills',
    label: 'Skills',
    description: 'Reusable capabilities and procedures.',
    Icon: SkillsIcon,
  },
  {
    type: 'subtitles',
    label: 'Subtitles',
    description: 'Intelligent chunk-based SRT/VTT subtitle translator.',
    Icon: SubtitlesIcon,
  },
  {
    type: 'connections',
    label: 'Connections',
    description: 'Connect MCP servers and inspect their real tools.',
    Icon: ConnectionsIcon,
  },
  {
    type: 'channels',
    label: 'Channels',
    description: 'Bridge Telegram and Discord messaging to IRIS.',
    Icon: ChannelsIcon,
  },
  {
    type: 'settings',
    label: 'System',
    description: 'Inspect tool authority and local permission decisions.',
    Icon: SystemIcon,
  },
];
