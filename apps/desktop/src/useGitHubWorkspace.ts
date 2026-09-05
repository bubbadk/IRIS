import type { AgentDefinition } from '@iris/core';
import type {
  GitHubAuthStatus,
  GitHubIssue,
  GitHubRelease,
  GitHubRepo,
  GitHubWorkflow,
  GitHubWorkflowRun,
  NewProjectDraft,
} from '@iris/github';
import { bumpSemVer, generateProjectScaffolding } from '@iris/github';
import { useEffect, useMemo, useState } from 'react';
import { agentRuntime } from './agentRuntime';
import {
  clearGitHubToken,
  githubService,
  initGitHubService,
  persistGitHubToken,
} from './githubService';
import { agentRepository } from './persistence';
import { chatSessions, useChatSession } from './useChatSession';
import { workspaceService } from './workspace';

export function useGitHubWorkspace() {
  const [authStatus, setAuthStatus] = useState<GitHubAuthStatus>({ authenticated: false });
  const [tokenInput, setTokenInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Repositories
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [repoSearch, setRepoSearch] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);

  // Active Tab for selected repo
  const [activeTab, setActiveTab] = useState<'agent' | 'releases' | 'workflows'>('agent');

  // Repo details
  const [releases, setReleases] = useState<GitHubRelease[]>([]);
  const [workflows, setWorkflows] = useState<GitHubWorkflow[]>([]);
  const [workflowRuns, setWorkflowRuns] = useState<GitHubWorkflowRun[]>([]);
  const [issues, setIssues] = useState<GitHubIssue[]>([]);

  // Agent Chat State
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [composerInput, setComposerInput] = useState('');
  const {
    messages,
    busy: agentWorking,
    assistantDraft,
    approval,
    approvalInput,
    activity: agentActivity,
    error: agentError,
  } = useChatSession(selectedAgentId);

  // New Project Walkthrough Wizard State
  const [showWizard, setShowWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3 | 4>(1);
  const [newProject, setNewProject] = useState<NewProjectDraft>({
    name: '',
    description: '',
    website: '',
    topics: [],
    includeReleases: true,
    includeDeployments: true,
    includePackages: true,
    isPrivate: false,
    license: 'MIT',
    template: 'rust-tauri',
    setupActionsWorkflow: true,
  });
  const [topicsInput, setTopicsInput] = useState('');
  const [wizardStatus, setWizardStatus] = useState<
    'idle' | 'scaffolding' | 'pushing' | 'completed'
  >('idle');

  // Release Creation Modal State
  const [showReleaseModal, setShowReleaseModal] = useState(false);
  const [newReleaseTag, setNewReleaseTag] = useState('v0.2.0');
  const [newReleaseTitle, setNewReleaseTitle] = useState('Release v0.2.0');
  const [newReleaseNotes, setNewReleaseNotes] = useState('');

  // Initial load
  useEffect(() => {
    let active = true;
    async function init() {
      setLoading(true);
      await initGitHubService();
      const status = await githubService.validateAuth();
      if (!active) return;
      setAuthStatus(status);
      if (status.authenticated) {
        try {
          const list = await githubService.listRepositories();
          if (active) setRepos(list);
        } catch (err) {
          if (active) setError(err instanceof Error ? err.message : String(err));
        }
      }
      const loadedAgents = await agentRepository.list();
      if (!active) return;
      setAgents(loadedAgents);
      const ghAgent = loadedAgents.find((a) => a.autonomy === 'github') || loadedAgents[0];
      if (ghAgent) setSelectedAgentId(ghAgent.id);
      setLoading(false);
    }
    void init().catch((err: unknown) => {
      if (active) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  // When repo is selected, fetch details
  useEffect(() => {
    if (!selectedRepo || !authStatus.authenticated) return;
    let active = true;
    setReleases([]);
    setWorkflows([]);
    setWorkflowRuns([]);
    setIssues([]);
    async function loadRepoData() {
      if (!selectedRepo) return;
      const owner = selectedRepo.owner.login;
      const repo = selectedRepo.name;
      try {
        const [loadedReleases, loadedWorkflows, loadedRuns, loadedIssues] =
          await Promise.allSettled([
            githubService.listReleases(owner, repo),
            githubService.listWorkflows(owner, repo),
            githubService.listWorkflowRuns(owner, repo),
            githubService.listIssues(owner, repo, 'open'),
          ]);
        if (!active) return;
        const failures = [loadedReleases, loadedWorkflows, loadedRuns, loadedIssues].filter(
          (result) => result.status === 'rejected',
        );
        if (failures.length)
          setError(
            'Some repository details could not be loaded. Check your connection and GitHub permissions.',
          );
        if (loadedReleases.status === 'fulfilled') setReleases(loadedReleases.value);
        if (loadedWorkflows.status === 'fulfilled') setWorkflows(loadedWorkflows.value);
        if (loadedRuns.status === 'fulfilled') setWorkflowRuns(loadedRuns.value);
        if (loadedIssues.status === 'fulfilled') setIssues(loadedIssues.value);

        // Pre-fill next release tag suggestion
        if (loadedReleases.status === 'fulfilled' && loadedReleases.value.length > 0) {
          const latestTag = loadedReleases.value[0]?.tag_name || 'v0.1.0';
          const nextTag = bumpSemVer(latestTag, 'minor');
          setNewReleaseTag(nextTag);
          setNewReleaseTitle(`Release ${nextTag}`);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      }
    }
    loadRepoData();
    return () => {
      active = false;
    };
  }, [selectedRepo, authStatus.authenticated]);

  // Handle Sign In
  async function handleSignIn() {
    if (!tokenInput.trim()) return;
    setBusy(true);
    setError('');
    try {
      await persistGitHubToken(tokenInput.trim());
      const status = await githubService.validateAuth();
      setAuthStatus(status);
      if (status.authenticated) {
        const list = await githubService.listRepositories();
        setRepos(list);
        setTokenInput('');
      } else {
        setError(
          status.error || 'Authentication failed. Please verify your GitHub Personal Access Token.',
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Handle Sign Out
  async function handleSignOut() {
    setBusy(true);
    try {
      await clearGitHubToken();
      setAuthStatus({ authenticated: false });
      setRepos([]);
      setSelectedRepo(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Send message to GitHub agent
  async function handleSendMessage(promptText?: string) {
    const textToSend = promptText || composerInput;
    if (!textToSend.trim() || !selectedAgentId || agentWorking || approval) return;

    setComposerInput('');
    const contextPrefix = selectedRepo
      ? `[Repository: ${selectedRepo.full_name}, Default Branch: ${selectedRepo.default_branch}]\n`
      : '';
    await chatSessions.send(selectedAgentId, `${contextPrefix}${textToSend}`);
  }

  // Handle New Project Creation
  async function handleCreateProject() {
    if (!newProject.name.trim()) {
      setError('Project name is required.');
      return;
    }

    setWizardStatus('scaffolding');
    setError('');

    try {
      const topics = topicsInput
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      const draft: NewProjectDraft = {
        ...newProject,
        topics,
      };

      const files = generateProjectScaffolding(draft);

      for (const file of files) {
        await workspaceService.writeFile(file.path, file.content, false);
      }

      setWizardStatus('pushing');
      const createdRepo = await githubService.createRepository(draft);

      setRepos((prev) => [createdRepo, ...prev]);
      setSelectedRepo(createdRepo);
      setWizardStatus('completed');
      setWizardStep(4);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setWizardStatus('idle');
    }
  }

  // Handle Publish Release
  async function handlePublishRelease() {
    if (!selectedRepo || !newReleaseTag.trim()) return;
    setBusy(true);
    setError('');
    try {
      const owner = selectedRepo.owner.login;
      const repo = selectedRepo.name;

      const fullNotes = newReleaseNotes.trim();
      if (!fullNotes) throw new Error('Write concrete release notes before publishing.');

      const created = await githubService.createRelease(owner, repo, {
        tagName: newReleaseTag,
        name: newReleaseTitle || newReleaseTag,
        body: fullNotes,
        draft: false,
        prerelease: false,
      });

      setReleases((prev) => [created, ...prev]);

      if (workflows.length > 0) {
        const releaseWorkflow = workflows.find(
          (w) => w.path.includes('release') || w.name.toLowerCase().includes('release'),
        );
        if (releaseWorkflow) {
          await githubService.triggerWorkflow(
            owner,
            repo,
            releaseWorkflow.id,
            selectedRepo.default_branch,
          );
        }
      }

      setShowReleaseModal(false);
      setNewReleaseNotes('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Handle Toggle Repository Visibility (Public <-> Private)
  async function handleToggleVisibility() {
    if (!selectedRepo) return;
    const targetPrivacy = !selectedRepo.private;
    const confirmMessage = targetPrivacy
      ? `Are you sure you want to make ${selectedRepo.name} PRIVATE?`
      : `Are you sure you want to make ${selectedRepo.name} PUBLIC?`;
    if (!window.confirm(confirmMessage)) return;

    setBusy(true);
    setError('');
    try {
      const updated = await githubService.updateRepositoryVisibility(
        selectedRepo.owner.login,
        selectedRepo.name,
        targetPrivacy,
      );
      setSelectedRepo(updated);
      setRepos((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Handle Toggle Takeover (Switch to expert model on the fly)
  async function handleToggleTakeover() {
    const agent = agents.find((a) => a.id === selectedAgentId);
    if (!agent) return;

    if (!agent.takeoverModel) {
      setError(
        `Agent "${agent.name}" does not have a Takeover Model configured. Open the agent editor to select a Takeover Model under Expert AI.`,
      );
      return;
    }

    setBusy(true);
    setError('');
    try {
      const isCurrentlyTakeover = agent.model === agent.takeoverModel;
      const targetModel = agent.takeoverModel;
      const targetProvider = agent.takeoverProviderPolicyId || agent.providerPolicyId;

      const updated: AgentDefinition = {
        ...agent,
        model: targetModel,
        providerPolicyId: targetProvider,
        takeoverModel: agent.model,
        takeoverProviderPolicyId: agent.providerPolicyId,
      };

      await agentRepository.save(updated);
      agentRuntime.refreshConfiguration(updated.id);
      setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));

      if (!isCurrentlyTakeover) {
        await handleSendMessage(
          `⚡ [TAKEOVER ACTIVATED: ${targetModel}] Taking over this turn with expert reasoning capabilities. Reviewing previous context and proceeding with advanced solution.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Filtered repositories
  const filteredRepos = useMemo(() => {
    const q = repoSearch.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.description && r.description.toLowerCase().includes(q)),
    );
  }, [repos, repoSearch]);

  const currentAgent = useMemo(
    () => agents.find((a) => a.id === selectedAgentId),
    [agents, selectedAgentId],
  );

  return {
    authStatus,
    setAuthStatus,
    tokenInput,
    setTokenInput,
    loading,
    setLoading,
    busy,
    setBusy,
    error,
    setError,
    repos,
    setRepos,
    repoSearch,
    setRepoSearch,
    selectedRepo,
    setSelectedRepo,
    activeTab,
    setActiveTab,
    releases,
    setReleases,
    workflows,
    setWorkflows,
    workflowRuns,
    setWorkflowRuns,
    issues,
    setIssues,
    agents,
    setAgents,
    selectedAgentId,
    setSelectedAgentId,
    composerInput,
    setComposerInput,
    messages,
    agentWorking,
    assistantDraft,
    approval,
    approvalInput,
    agentActivity,
    agentError,
    showWizard,
    setShowWizard,
    wizardStep,
    setWizardStep,
    newProject,
    setNewProject,
    topicsInput,
    setTopicsInput,
    wizardStatus,
    setWizardStatus,
    showReleaseModal,
    setShowReleaseModal,
    newReleaseTag,
    setNewReleaseTag,
    newReleaseTitle,
    setNewReleaseTitle,
    newReleaseNotes,
    setNewReleaseNotes,
    handleSignIn,
    handleSignOut,
    handleSendMessage,
    handleCreateProject,
    handlePublishRelease,
    handleToggleVisibility,
    handleToggleTakeover,
    filteredRepos,
    currentAgent,
  };
}
