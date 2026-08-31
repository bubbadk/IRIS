import { GitHubService } from '@iris/github';
import { loadProviderSecrets, saveProviderSecrets, deleteProviderSecrets } from './credentials';

export const GITHUB_INTEGRATION_KEY = 'github_integration';

export const githubService = new GitHubService();

export async function initGitHubService(): Promise<void> {
  try {
    const secrets = await loadProviderSecrets(GITHUB_INTEGRATION_KEY);
    if (secrets && secrets.token) {
      githubService.setToken(secrets.token);
    }
  } catch {
    // Ignore initial load error if keyring is empty
  }
}

export async function persistGitHubToken(token: string): Promise<void> {
  githubService.setToken(token);
  await saveProviderSecrets(GITHUB_INTEGRATION_KEY, { token });
}

export async function clearGitHubToken(): Promise<void> {
  githubService.setToken('');
  await deleteProviderSecrets(GITHUB_INTEGRATION_KEY);
}
