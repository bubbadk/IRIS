export interface GitHubUser {
  login: string;
  id: number;
  name?: string;
  avatar_url?: string;
  html_url: string;
  bio?: string;
  public_repos?: number;
}

export interface GitHubRepoOwner {
  login: string;
  avatar_url?: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: GitHubRepoOwner;
  html_url: string;
  description?: string | null;
  private: boolean;
  fork: boolean;
  default_branch: string;
  stargazers_count: number;
  open_issues_count: number;
  topics?: string[];
  updated_at: string;
  created_at: string;
  homepage?: string | null;
}

export interface GitHubReleaseAsset {
  id: number;
  name: string;
  size: number;
  download_count: number;
  browser_download_url: string;
  content_type: string;
}

export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string;
  body?: string | null;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at?: string | null;
  html_url: string;
  assets: GitHubReleaseAsset[];
}

export interface GitHubWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

export interface GitHubWorkflowRun {
  id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  status: string; // "queued", "in_progress", "completed"
  conclusion?: string | null; // "success", "failure", "cancelled", etc.
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  html_url: string;
  user: {
    login: string;
    avatar_url?: string;
  };
  labels?: { name: string; color: string }[];
  created_at: string;
  updated_at: string;
}

export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  html_url: string;
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
    sha: string;
  };
  user: {
    login: string;
    avatar_url?: string;
  };
  created_at: string;
  updated_at: string;
}

export interface GitHubReleaseDraft {
  tagName: string;
  name: string;
  body: string;
  draft?: boolean;
  prerelease?: boolean;
  targetCommitish?: string;
}

export type LicenseType = 'MIT' | 'Apache-2.0' | 'GPL-3.0' | 'BSD-3-Clause' | 'None';
export type ProjectTemplateType = 'rust-tauri' | 'typescript-node' | 'web-app' | 'python' | 'blank';

export interface NewProjectDraft {
  name: string;
  description?: string;
  website?: string;
  topics?: string[];
  includeReleases?: boolean;
  includeDeployments?: boolean;
  includePackages?: boolean;
  isPrivate?: boolean;
  license?: LicenseType;
  template?: ProjectTemplateType;
  setupActionsWorkflow?: boolean;
}

export interface GitHubAuthStatus {
  authenticated: boolean;
  user?: GitHubUser;
  scopes?: string[];
  error?: string;
}
