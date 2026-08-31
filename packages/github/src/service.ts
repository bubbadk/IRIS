import type {
  GitHubAuthStatus,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRelease,
  GitHubReleaseDraft,
  GitHubRepo,
  GitHubUser,
  GitHubWorkflow,
  GitHubWorkflowRun,
  NewProjectDraft,
} from './types';

const GITHUB_API_BASE = 'https://api.github.com';

export interface GitHubRequestOptions {
  token: string;
  endpoint: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function githubFetch<T>(options: GitHubRequestOptions): Promise<T> {
  const url = options.endpoint.startsWith('http')
    ? options.endpoint
    : `${GITHUB_API_BASE}${options.endpoint.startsWith('/') ? '' : '/'}${options.endpoint}`;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'IRIS-Operating-Environment/0.2.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  if (options.token.trim().length > 0) {
    headers.Authorization = `Bearer ${options.token.trim()}`;
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (!response.ok) {
    let errorDetail = response.statusText;
    try {
      const errJson = (await response.json()) as { message?: string };
      if (errJson?.message) {
        errorDetail = errJson.message;
      }
    } catch {
      // Ignore parse error and keep status text
    }
    throw new Error(`GitHub API error (${response.status}): ${errorDetail}`);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return (await response.json()) as T;
}

export class GitHubService {
  constructor(private token: string = '') {}

  setToken(token: string): void {
    this.token = token;
  }

  getToken(): string {
    return this.token;
  }

  async validateAuth(signal?: AbortSignal): Promise<GitHubAuthStatus> {
    if (!this.token || this.token.trim().length === 0) {
      return { authenticated: false, error: 'No GitHub token configured.' };
    }

    try {
      const user = await githubFetch<GitHubUser>({
        token: this.token,
        endpoint: '/user',
        signal,
      });

      return {
        authenticated: true,
        user,
      };
    } catch (err) {
      return {
        authenticated: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listRepositories(signal?: AbortSignal): Promise<GitHubRepo[]> {
    return await githubFetch<GitHubRepo[]>({
      token: this.token,
      endpoint: '/user/repos?sort=updated&per_page=50',
      signal,
    });
  }

  async getRepository(owner: string, repo: string, signal?: AbortSignal): Promise<GitHubRepo> {
    return await githubFetch<GitHubRepo>({
      token: this.token,
      endpoint: `/repos/${owner}/${repo}`,
      signal,
    });
  }

  async createRepository(draft: NewProjectDraft, signal?: AbortSignal): Promise<GitHubRepo> {
    const payload = {
      name: draft.name,
      description: draft.description || '',
      homepage: draft.website || '',
      private: Boolean(draft.isPrivate),
      has_issues: true,
      has_projects: true,
      has_wiki: false,
      auto_init: true,
    };

    const repo = await githubFetch<GitHubRepo>({
      token: this.token,
      endpoint: '/user/repos',
      method: 'POST',
      body: payload,
      signal,
    });

    if (draft.topics && draft.topics.length > 0) {
      try {
        await githubFetch({
          token: this.token,
          endpoint: `/repos/${repo.owner.login}/${repo.name}/topics`,
          method: 'PUT',
          body: { names: draft.topics },
          signal,
        });
      } catch {
        // Non-critical if topic update fails
      }
    }

    return repo;
  }

  async updateRepositoryVisibility(
    owner: string,
    repo: string,
    isPrivate: boolean,
    signal?: AbortSignal
  ): Promise<GitHubRepo> {
    return await githubFetch<GitHubRepo>({
      token: this.token,
      endpoint: `/repos/${owner}/${repo}`,
      method: 'PATCH',
      body: { private: isPrivate },
      signal,
    });
  }

  async listReleases(owner: string, repo: string, signal?: AbortSignal): Promise<GitHubRelease[]> {
    return await githubFetch<GitHubRelease[]>({
      token: this.token,
      endpoint: `/repos/${owner}/${repo}/releases?per_page=30`,
      signal,
    });
  }

  async createRelease(
    owner: string,
    repo: string,
    release: GitHubReleaseDraft,
    signal?: AbortSignal
  ): Promise<GitHubRelease> {
    const payload = {
      tag_name: release.tagName,
      name: release.name || release.tagName,
      body: release.body || '',
      draft: Boolean(release.draft),
      prerelease: Boolean(release.prerelease),
      target_commitish: release.targetCommitish || 'main',
      generate_release_notes: true,
    };

    return await githubFetch<GitHubRelease>({
      token: this.token,
      endpoint: `/repos/${owner}/${repo}/releases`,
      method: 'POST',
      body: payload,
      signal,
    });
  }

  async listWorkflows(owner: string, repo: string, signal?: AbortSignal): Promise<GitHubWorkflow[]> {
    const data = await githubFetch<{ workflows: GitHubWorkflow[] }>({
      token: this.token,
      endpoint: `/repos/${owner}/${repo}/actions/workflows`,
      signal,
    });
    return data.workflows || [];
  }

  async listWorkflowRuns(
    owner: string,
    repo: string,
    workflowId?: number,
    signal?: AbortSignal
  ): Promise<GitHubWorkflowRun[]> {
    const endpoint = workflowId
      ? `/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs?per_page=20`
      : `/repos/${owner}/${repo}/actions/runs?per_page=20`;

    const data = await githubFetch<{ workflow_runs: GitHubWorkflowRun[] }>({
      token: this.token,
      endpoint,
      signal,
    });
    return data.workflow_runs || [];
  }

  async triggerWorkflow(
    owner: string,
    repo: string,
    workflowIdOrFilename: string | number,
    ref: string = 'main',
    inputs?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<boolean> {
    await githubFetch({
      token: this.token,
      endpoint: `/repos/${owner}/${repo}/actions/workflows/${workflowIdOrFilename}/dispatches`,
      method: 'POST',
      body: {
        ref,
        inputs: inputs || {},
      },
      signal,
    });
    return true;
  }

  async listIssues(
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all' = 'open',
    signal?: AbortSignal
  ): Promise<GitHubIssue[]> {
    return await githubFetch<GitHubIssue[]>({
      token: this.token,
      endpoint: `/repos/${owner}/${repo}/issues?state=${state}&per_page=50`,
      signal,
    });
  }

  async createPullRequest(
    owner: string,
    repo: string,
    pr: { title: string; head: string; base: string; body?: string },
    signal?: AbortSignal
  ): Promise<GitHubPullRequest> {
    return await githubFetch<GitHubPullRequest>({
      token: this.token,
      endpoint: `/repos/${owner}/${repo}/pulls`,
      method: 'POST',
      body: pr,
      signal,
    });
  }
}
