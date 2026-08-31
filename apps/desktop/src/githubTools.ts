import type { RegisteredTool } from '@iris/tools';
import { githubService } from './githubService';
import type { GitHubReleaseDraft, NewProjectDraft } from '@iris/github';

export function createGitHubListReposTool(): RegisteredTool {
  return {
    id: 'github.list_repos',
    name: 'List GitHub Repositories',
    description: 'Lists repositories for the authenticated GitHub account.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async run(_input, context) {
      return await githubService.listRepositories(context.signal);
    },
  };
}

export function createGitHubGetRepoTool(): RegisteredTool {
  return {
    id: 'github.get_repo',
    name: 'Get GitHub Repository',
    description: 'Fetches details of a specific GitHub repository.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
    async run(input, context) {
      const { owner, repo } = (input || {}) as { owner: string; repo: string };
      if (!owner || !repo) throw new Error('owner and repo parameters are required');
      return await githubService.getRepository(owner, repo, context.signal);
    },
  };
}

export function createGitHubCreateRepoTool(): RegisteredTool {
  return {
    id: 'github.create_repo',
    name: 'Create GitHub Repository',
    description: 'Creates a new GitHub repository with structured metadata.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Short repository description' },
        website: { type: 'string', description: 'Website URL' },
        topics: { type: 'array', items: { type: 'string' }, description: 'Topics/tags' },
        isPrivate: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
    async run(input, context) {
      const draft = (input || {}) as NewProjectDraft;
      if (!draft.name || draft.name.trim().length === 0) throw new Error('Repository name is required');
      return await githubService.createRepository(draft, context.signal);
    },
  };
}

export function createGitHubCreateReleaseTool(): RegisteredTool {
  return {
    id: 'github.create_release',
    name: 'Create GitHub Release',
    description: 'Creates a versioned release, publishes release notes and triggers automated binary builds.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        tagName: { type: 'string', description: 'SemVer tag name (e.g. v0.2.0)' },
        name: { type: 'string', description: 'Release title' },
        body: { type: 'string', description: 'Release notes / changelog' },
        draft: { type: 'boolean', description: 'Save as draft' },
        prerelease: { type: 'boolean', description: 'Mark as prerelease' },
      },
      required: ['owner', 'repo', 'tagName'],
    },
    async run(input, context) {
      const { owner, repo, ...draft } = (input || {}) as {
        owner: string;
        repo: string;
      } & GitHubReleaseDraft;
      if (!owner || !repo || !draft.tagName) {
        throw new Error('owner, repo and tagName are required');
      }
      return await githubService.createRelease(owner, repo, draft, context.signal);
    },
  };
}

export function createGitHubTriggerWorkflowTool(): RegisteredTool {
  return {
    id: 'github.trigger_workflow',
    name: 'Trigger GitHub Actions Workflow',
    description: 'Triggers a GitHub Actions workflow to build release binaries or run test suites.',
    risk: 'execute',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        workflowIdOrFilename: { type: 'string', description: 'Workflow ID or filename (e.g. release.yml)' },
        ref: { type: 'string', description: 'Branch or tag reference (default: main)' },
        inputs: { type: 'object', description: 'Workflow input parameters' },
      },
      required: ['owner', 'repo', 'workflowIdOrFilename'],
    },
    async run(input, context) {
      const { owner, repo, workflowIdOrFilename, ref, inputs } = (input || {}) as {
        owner: string;
        repo: string;
        workflowIdOrFilename: string;
        ref?: string;
        inputs?: Record<string, unknown>;
      };
      if (!owner || !repo || !workflowIdOrFilename) {
        throw new Error('owner, repo and workflowIdOrFilename are required');
      }
      return await githubService.triggerWorkflow(
        owner,
        repo,
        workflowIdOrFilename,
        ref || 'main',
        inputs,
        context.signal
      );
    },
  };
}

export function createGitHubGetWorkflowStatusTool(): RegisteredTool {
  return {
    id: 'github.get_workflow_status',
    name: 'Get Workflow Status',
    description: 'Fetches recent workflow runs and their binary build statuses.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        workflowId: { type: 'number', description: 'Optional workflow ID' },
      },
      required: ['owner', 'repo'],
    },
    async run(input, context) {
      const { owner, repo, workflowId } = (input || {}) as {
        owner: string;
        repo: string;
        workflowId?: number;
      };
      if (!owner || !repo) throw new Error('owner and repo are required');
      return await githubService.listWorkflowRuns(owner, repo, workflowId, context.signal);
    },
  };
}

export function createGitHubListIssuesTool(): RegisteredTool {
  return {
    id: 'github.list_issues',
    name: 'List GitHub Issues',
    description: 'Lists issues for a repository to inspect bugs or requested features.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state' },
      },
      required: ['owner', 'repo'],
    },
    async run(input, context) {
      const { owner, repo, state } = (input || {}) as {
        owner: string;
        repo: string;
        state?: 'open' | 'closed' | 'all';
      };
      if (!owner || !repo) throw new Error('owner and repo are required');
      return await githubService.listIssues(owner, repo, state || 'open', context.signal);
    },
  };
}

export function createGitHubCreatePullRequestTool(): RegisteredTool {
  return {
    id: 'github.create_pull_request',
    name: 'Create Pull Request',
    description: 'Opens a pull request on GitHub with version changes and descriptions.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name (e.g. main)' },
        body: { type: 'string', description: 'Pull request description' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    async run(input, context) {
      const { owner, repo, ...pr } = (input || {}) as {
        owner: string;
        repo: string;
        title: string;
        head: string;
        base: string;
        body?: string;
      };
      if (!owner || !repo || !pr.title || !pr.head || !pr.base) {
        throw new Error('owner, repo, title, head and base are required');
      }
      return await githubService.createPullRequest(owner, repo, pr, context.signal);
    },
  };
}

export function createAllGitHubTools(): RegisteredTool[] {
  return [
    createGitHubListReposTool(),
    createGitHubGetRepoTool(),
    createGitHubCreateRepoTool(),
    createGitHubCreateReleaseTool(),
    createGitHubTriggerWorkflowTool(),
    createGitHubGetWorkflowStatusTool(),
    createGitHubListIssuesTool(),
    createGitHubCreatePullRequestTool(),
  ];
}
