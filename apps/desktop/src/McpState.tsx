import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  connectableRemote,
  describeRegistryEntry,
  mcpAuthKind,
  type McpPromptDescriptor,
  type McpResourceDescriptor,
  type McpResourceTemplateDescriptor,
  type McpRegistryEntry,
  type McpRegistryPage,
  type McpServerConnection,
  type McpElicitationResponse,
} from '@iris/mcp';
import type { ToolDefinition } from '@iris/tools';
import { isTauriRuntime } from './credentials';
import { mcpRegistry, mcpRegistryPageSize } from './mcpRegistry';
import {
  addMcpServer,
  addStdioMcpServer,
  completeMcp,
  configureMcpSampling,
  describeMcpError,
  McpReauthorizationRequiredError,
  probeMcpServer,
  reauthorizeMcpServer,
  signInAndConnect,
  listMcpServers,
  listMcpPrompts,
  getMcpPrompt,
  listMcpResources,
  listMcpResourceTemplates,
  listMcpServerRequestPolicies,
  readMcpResource,
  refreshMcpServer,
  registeredMcpToolIds,
  removeMcpServer,
  subscribeMcpServers,
  setMcpServerRequestPolicy,
  listPendingMcpElicitations,
  resolveMcpElicitation,
  subscribeMcpElicitations,
  type McpElicitationPending,
} from './mcp';
import { supportedMcpServerRequestMethods } from '@iris/mcp';
import { loadProviderConfigs } from '@iris/providers';
import { toolRegistry } from './tooling';

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const emptyDraft = { name: '', url: '', token: '', command: '', args: '', oauthClientId: '' };

function ElicitationCard({ pending }: { pending: McpElicitationPending }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  function respond(
    action: McpElicitationResponse['action'],
    content?: McpElicitationResponse['content'],
  ) {
    setSubmitting(true);
    if (!resolveMcpElicitation(pending.id, { action, ...(content ? { content } : {}) })) {
      setSubmitting(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content: Record<string, string | number | boolean> = {};
    for (const field of pending.request.fields) {
      const value = values[field.name] ?? '';
      if (field.type === 'boolean') content[field.name] = value === 'true';
      else if (field.type === 'number') content[field.name] = Number(value);
      else content[field.name] = value;
    }
    respond('accept', content);
  }

  return (
    <section className="agent-tool-state approval-needed" aria-label="MCP input request">
      <div>
        <p className="eyebrow">MCP input request</p>
        <strong>{pending.serverName} is asking for information</strong>
        <p>{pending.request.message}</p>
        <form className="skill-editor" onSubmit={submit}>
          {pending.request.fields.map((field) => (
            <label key={field.name}>
              <span>
                {field.title}
                {field.required ? ' · required' : ''}
              </span>
              {field.enum ? (
                <select
                  required={field.required}
                  value={values[field.name] ?? ''}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [field.name]: event.target.value }))
                  }
                >
                  <option value="">Choose…</option>
                  {field.enum.map((option) => (
                    <option value={option} key={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : field.type === 'boolean' ? (
                <select
                  required={field.required}
                  value={values[field.name] ?? ''}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [field.name]: event.target.value }))
                  }
                >
                  <option value="">Choose…</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              ) : (
                <input
                  required={field.required}
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={values[field.name] ?? ''}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [field.name]: event.target.value }))
                  }
                />
              )}
              {field.description && <small>{field.description}</small>}
            </label>
          ))}
          <div className="agent-tool-actions">
            <button
              type="button"
              className="row-button"
              disabled={submitting}
              onClick={() => respond('cancel')}
            >
              Cancel
            </button>
            <button
              type="button"
              className="row-button"
              disabled={submitting}
              onClick={() => respond('decline')}
            >
              Decline
            </button>
            <button type="submit" className="row-button approval-button" disabled={submitting}>
              Send to server
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

export function McpState() {
  const native = isTauriRuntime();
  const [view, setView] = useState<'servers' | 'directory'>('servers');
  const [servers, setServers] = useState<McpServerConnection[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [transport, setTransport] = useState<'http' | 'stdio'>('http');
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signInRequest, setSignInRequest] = useState<{
    resourceMetadataUrl: string;
    scopes: string[];
  } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [toolVersion, setToolVersion] = useState(0);
  const [prompts, setPrompts] = useState<McpPromptDescriptor[]>([]);
  const [promptPreview, setPromptPreview] = useState<string | null>(null);
  const [promptArgumentValues, setPromptArgumentValues] = useState<Record<string, string>>({});
  const [completionPreview, setCompletionPreview] = useState<string | null>(null);
  const [resources, setResources] = useState<McpResourceDescriptor[]>([]);
  const [resourceTemplates, setResourceTemplates] = useState<McpResourceTemplateDescriptor[]>([]);
  const [requestPolicies, setRequestPolicies] = useState<Record<string, 'allow' | 'deny'>>({});
  const [samplingProviderId, setSamplingProviderId] = useState('');
  const [samplingModel, setSamplingModel] = useState('');
  const [resourcePreview, setResourcePreview] = useState<string | null>(null);
  const [reauthorization, setReauthorization] = useState<{
    serverId: string;
    resourceMetadataUrl: string;
    scopes: string[];
  } | null>(null);
  const [elicitations, setElicitations] = useState(listPendingMcpElicitations);

  const [page, setPage] = useState<McpRegistryPage | null>(null);
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorTrail, setCursorTrail] = useState<Array<string | undefined>>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');

  const reload = useCallback(async () => {
    setServers(await listMcpServers());
    setLoaded(true);
  }, []);

  useEffect(() => {
    void reload();
    return subscribeMcpServers(() => {
      void reload();
      setToolVersion((current) => current + 1);
    });
  }, [reload]);

  useEffect(
    () => subscribeMcpElicitations(() => setElicitations(listPendingMcpElicitations())),
    [],
  );

  const loadCatalog = useCallback(
    async (signal: AbortSignal) => {
      setCatalogLoading(true);
      setCatalogError('');
      try {
        const result = await mcpRegistry.browse(
          { search: submittedQuery, cursor, limit: mcpRegistryPageSize },
          signal,
        );
        if (!signal.aborted) setPage(result);
      } catch (browseError) {
        if (signal.aborted) return;
        setPage(null);
        setCatalogError(`The MCP registry is unavailable: ${describeMcpError(browseError)}`);
      } finally {
        if (!signal.aborted) setCatalogLoading(false);
      }
    },
    [cursor, submittedQuery],
  );

  useEffect(() => {
    if (view !== 'directory') return;
    const controller = new AbortController();
    void loadCatalog(controller.signal);
    return () => controller.abort();
  }, [loadCatalog, view]);

  const selected = useMemo(
    () => servers.find((server) => server.id === selectedId) ?? null,
    [selectedId, servers],
  );
  const providerConfigs = useMemo(
    () => loadProviderConfigs().filter((provider) => provider.enabled),
    [toolVersion],
  );

  const selectedTools = useMemo<ToolDefinition[]>(() => {
    void toolVersion;
    if (!selected) return [];
    const ids = new Set(registeredMcpToolIds(selected.id));
    return toolRegistry.list().filter((tool) => ids.has(tool.id));
  }, [selected, toolVersion]);

  // Any MCP change anywhere — even on a different server — bumps toolVersion and gives `selected` a
  // new object reference, so this effect re-runs far more often than "the selected server changed".
  // Only clear the panel's displayed state on a genuine server switch; a same-server refresh (e.g.
  // after picking a sampling model) should quietly update in place instead of flashing every field
  // back to its empty/deny default while the refetch is in flight.
  const loadedServerIdRef = useRef<string | null>(null);
  useEffect(() => {
    const isServerSwitch = selected?.id !== loadedServerIdRef.current;
    if (isServerSwitch) {
      setPrompts([]);
      setPromptPreview(null);
      setResources([]);
      setResourceTemplates([]);
      setRequestPolicies({});
      setSamplingProviderId('');
      setSamplingModel('');
      setResourcePreview(null);
    }
    loadedServerIdRef.current = selected?.id ?? null;
    if (!selected) return;
    let active = true;
    void Promise.all([
      listMcpPrompts(selected.id),
      listMcpResources(selected.id),
      listMcpResourceTemplates(selected.id),
      listMcpServerRequestPolicies(selected.id),
    ])
      .then(([promptItems, resourceItems, resourceTemplateItems, policies]) => {
        if (!active) return;
        setPrompts(promptItems);
        setResources(resourceItems);
        setResourceTemplates(resourceTemplateItems);
        setRequestPolicies(
          Object.fromEntries(policies.map((policy) => [policy.method, policy.decision])),
        );
        setSamplingProviderId(selected.samplingProviderId ?? '');
        setSamplingModel(selected.samplingModel ?? '');
      })
      .catch(() => {
        if (!active) return;
        if (isServerSwitch) {
          setPrompts([]);
          setResources([]);
          setRequestPolicies({});
        }
      });
    return () => {
      active = false;
    };
  }, [selected, toolVersion]);

  function connected(result: {
    server: { id: string };
    info: { serverName: string; serverVersion: string; protocolVersion: string };
    tools: unknown[];
    prompts: unknown[];
    resources: unknown[];
    resourceTemplates: unknown[];
  }) {
    setDraft(emptyDraft);
    setShowForm(false);
    setSignInRequest(null);
    setSelectedId(result.server.id);
    setToolVersion((current) => current + 1);
    setNotice(
      `Connected to ${result.info.serverName} (${result.info.serverVersion}) over MCP ${result.info.protocolVersion}. ${result.tools.length} tool${result.tools.length === 1 ? '' : 's'}, ${result.prompts.length} prompt${result.prompts.length === 1 ? '' : 's'}, ${result.resources.length} resource${result.resources.length === 1 ? '' : 's'} and ${result.resourceTemplates.length} resource template${result.resourceTemplates.length === 1 ? '' : 's'} discovered.`,
    );
  }

  async function connect() {
    setBusy(true);
    setError('');
    setNotice('');
    setSignInRequest(null);
    try {
      if (transport === 'stdio') {
        const args = draft.args.trim() ? JSON.parse(draft.args) : [];
        if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
          throw new Error('Local MCP arguments must be a JSON string array.');
        connected(
          await addStdioMcpServer({
            name: draft.name,
            configuration: { command: draft.command, args },
          }),
        );
        return;
      }
      const token = draft.token.trim();
      // Probe first: a server may answer the handshake, or invite a sign-in instead of failing.
      const probe = await probeMcpServer(draft.url, token || undefined);
      if (probe.status === 'sign-in-required') {
        setSignInRequest({
          resourceMetadataUrl: probe.resourceMetadataUrl,
          scopes: probe.scopes,
        });
        setNotice(
          'This server requires you to sign in. IRIS will register itself, open your browser for consent, and store the resulting token in the OS keyring.',
        );
        return;
      }
      connected(
        await addMcpServer({ name: draft.name, url: draft.url, ...(token ? { token } : {}) }),
      );
    } catch (connectError) {
      setNotice('');
      setError(describeMcpError(connectError));
    } finally {
      setBusy(false);
    }
  }

  async function startSignIn() {
    if (!signInRequest) return;
    setBusy(true);
    setError('');
    try {
      connected(
        await signInAndConnect(
          { name: draft.name, url: draft.url },
          signInRequest.resourceMetadataUrl,
          signInRequest.scopes,
          (message) => setNotice(message),
          undefined,
          draft.oauthClientId.trim() ? { clientId: draft.oauthClientId.trim() } : undefined,
        ),
      );
    } catch (signInError) {
      setNotice('');
      setError(describeMcpError(signInError));
    } finally {
      setBusy(false);
    }
  }

  async function refresh(server: McpServerConnection) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await refreshMcpServer(server.id);
      if (reauthorization?.serverId === server.id) setReauthorization(null);
      setToolVersion((current) => current + 1);
      setNotice(
        `${result.info.serverName} answered. ${result.tools.length} tool${result.tools.length === 1 ? '' : 's'} available.`,
      );
    } catch (refreshError) {
      setNotice('');
      if (refreshError instanceof McpReauthorizationRequiredError) {
        setReauthorization({
          serverId: refreshError.serverId,
          resourceMetadataUrl: refreshError.resourceMetadataUrl,
          scopes: refreshError.scopes,
        });
      }
      setError(describeMcpError(refreshError));
    } finally {
      setBusy(false);
    }
  }

  async function signInAgain(server: McpServerConnection) {
    if (mcpAuthKind(server) !== 'oauth' || !server.oauth) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await reauthorizeMcpServer(
        server.id,
        reauthorization?.serverId === server.id
          ? reauthorization.resourceMetadataUrl
          : server.oauth.resourceMetadataUrl,
        reauthorization?.serverId === server.id ? reauthorization.scopes : [],
        (message) => setNotice(message),
      );
      setReauthorization(null);
      setToolVersion((current) => current + 1);
      setNotice(
        `Signed in to ${result.info.serverName} again. ${result.tools.length} tool${result.tools.length === 1 ? '' : 's'} available.`,
      );
    } catch (signInError) {
      setNotice('');
      setError(describeMcpError(signInError));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(server: McpServerConnection) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await removeMcpServer(server.id);
      if (selectedId === server.id) setSelectedId(null);
      setToolVersion((current) => current + 1);
    } catch (removeError) {
      setError(
        removeError instanceof Error
          ? removeError.message
          : 'That MCP server could not be removed.',
      );
    } finally {
      setBusy(false);
    }
  }

  /** The registry publishes the real endpoint, so the form opens already filled in. */
  function prefillFrom(entry: McpRegistryEntry) {
    const remote = connectableRemote(entry);
    if (!remote) return;
    setDraft({
      name: entry.title,
      url: remote.url,
      token: '',
      command: '',
      args: '',
      oauthClientId: '',
    });
    setTransport('http');
    setShowForm(true);
    setView('servers');
    setError('');
    setNotice(
      remote.headerNames.includes('Authorization')
        ? `${entry.title} expects an Authorization header. Connect to see whether it accepts a bearer token or requires a sign-in.`
        : `${entry.title} is ready to connect at ${remote.url}.`,
    );
  }

  return (
    <div className="skills-state">
      {elicitations.map((pending) => (
        <ElicitationCard key={pending.id} pending={pending} />
      ))}
      <header className="skills-heading">
        <div>
          <p className="eyebrow">MCP connections</p>
          <h2>Bring outside tools under the same rules.</h2>
          <p>
            Connect a real MCP server. Its tools are discovered from the server itself and stay
            deny-by-default until you assign them to an agent and choose Ask, Allow or Deny.
          </p>
        </div>
        <button
          className="soft-button primary-button"
          disabled={busy || !native}
          onClick={() => {
            setShowForm(true);
            setView('servers');
          }}
        >
          + Add server
        </button>
      </header>

      <div className="skills-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={view === 'servers'}
          className={view === 'servers' ? 'selected' : ''}
          onClick={() => setView('servers')}
        >
          Your servers · {servers.length}
        </button>
        <button
          role="tab"
          aria-selected={view === 'directory'}
          className={view === 'directory' ? 'selected' : ''}
          onClick={() => setView('directory')}
        >
          Browse directory
        </button>
      </div>

      {!native && (
        <p className="skills-error">
          MCP servers can only be reached from the native IRIS desktop app. The browser preview does
          not simulate a connection.
        </p>
      )}
      {error && <p className="skills-error">{error}</p>}
      {notice && <p className="skill-catalog-count">{notice}</p>}

      {view === 'servers' && showForm && (
        <section className="skill-editor" aria-label="Add MCP server">
          <p className="eyebrow">New connection</p>
          <label>
            Name
            <input
              value={draft.name}
              placeholder="Gmail"
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
          </label>
          {transport === 'http' && (
            <label>
              OAuth client ID (optional)
              <input
                value={draft.oauthClientId}
                placeholder="Use when the server has no dynamic registration"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, oauthClientId: event.target.value }))
                }
              />
            </label>
          )}
          <label>
            Transport
            <select
              value={transport}
              onChange={(event) => setTransport(event.target.value as 'http' | 'stdio')}
            >
              <option value="http">Remote HTTP</option>
              <option value="stdio">Local stdio command</option>
            </select>
          </label>
          {transport === 'stdio' ? (
            <>
              <label>
                Command
                <input
                  value={draft.command}
                  placeholder="npx"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, command: event.target.value }))
                  }
                />
              </label>
              <label>
                Arguments (JSON array)
                <input
                  value={draft.args}
                  placeholder='["-y", "@example/mcp-server"]'
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, args: event.target.value }))
                  }
                />
              </label>
            </>
          ) : (
            <>
              <label>
                Endpoint URL
                <input
                  value={draft.url}
                  placeholder="https://example.com/mcp"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, url: event.target.value }))
                  }
                />
              </label>
              <label>
                Bearer token (optional)
                <input
                  type="password"
                  value={draft.token}
                  placeholder="Stored in the OS keyring, never in local metadata"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, token: event.target.value }))
                  }
                />
              </label>
            </>
          )}
          <div className="skill-editor-footer">
            <small>
              IRIS connects before saving, so a stored connection always means the handshake really
              succeeded.
            </small>
            <div className="skill-editor-actions">
              <button
                className="row-button"
                disabled={busy}
                onClick={() => {
                  setShowForm(false);
                  setError('');
                }}
              >
                Cancel
              </button>
              {signInRequest ? (
                <button
                  className="soft-button primary-button"
                  disabled={busy || !native}
                  onClick={() => void startSignIn()}
                >
                  {busy ? 'Signing in…' : 'Sign in with browser'}
                </button>
              ) : (
                <button
                  className="soft-button primary-button"
                  disabled={busy || !native}
                  onClick={() => void connect()}
                >
                  {busy ? 'Connecting…' : 'Connect'}
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {view === 'directory' ? (
        <div className="skill-catalog">
          <form
            className="skill-catalog-toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              setCursor(undefined);
              setCursorTrail([]);
              setSubmittedQuery(query.trim());
            }}
          >
            <input
              value={query}
              placeholder="Search the official MCP registry…"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button className="row-button" type="submit" disabled={catalogLoading}>
              Search
            </button>
          </form>

          {catalogError && <p className="skills-error">{catalogError}</p>}

          {catalogLoading ? (
            <div className="skills-empty">Loading the official MCP registry…</div>
          ) : !page ? (
            <div className="skills-empty">
              <strong>Registry unavailable</strong>
              <p>IRIS could not reach the official MCP registry and will not show a stale list.</p>
            </div>
          ) : page.entries.length === 0 ? (
            <div className="skills-empty">
              <strong>No match</strong>
              <p>No server in the official MCP registry matches this search.</p>
            </div>
          ) : (
            <>
              <p className="skill-catalog-count">
                {page.entries.length} server{page.entries.length === 1 ? '' : 's'} from the official
                registry. Every address below is published by the registry itself.
              </p>
              <div className="skill-catalog-grid">
                {page.entries.map((entry) => {
                  const remote = connectableRemote(entry);
                  const connected = servers.some((server) => server.url === remote?.url);
                  return (
                    <article className="skill-catalog-card" key={`${entry.name}@${entry.version}`}>
                      <div className="skill-catalog-card-head">
                        <strong>{entry.title}</strong>
                        <em>{remote ? remote.transport : 'local'}</em>
                      </div>
                      <p>{entry.description}</p>
                      <p className="skill-catalog-meta">{describeRegistryEntry(entry)}</p>
                      <div className="skill-catalog-card-foot">
                        <small>
                          {entry.name} · {entry.version}
                        </small>
                        {connected ? (
                          <span className="skill-catalog-installed">Connected</span>
                        ) : remote ? (
                          <button className="row-button" onClick={() => prefillFrom(entry)}>
                            Add
                          </button>
                        ) : (
                          <span className="skill-catalog-installed">Not connectable</span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
              <div className="skill-catalog-pager">
                <button
                  className="row-button"
                  disabled={cursorTrail.length === 0}
                  onClick={() => {
                    setCursorTrail((trail) => {
                      const next = trail.slice(0, -1);
                      setCursor(trail[trail.length - 1]);
                      return next;
                    });
                  }}
                >
                  Previous
                </button>
                <span>{cursorTrail.length + 1}</span>
                <button
                  className="row-button"
                  disabled={!page.nextCursor}
                  onClick={() => {
                    setCursorTrail((trail) => [...trail, cursor]);
                    setCursor(page.nextCursor);
                  }}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </div>
      ) : !loaded ? (
        <div className="skills-empty">Loading MCP connections…</div>
      ) : servers.length === 0 ? (
        <div className="skills-empty">
          <strong>No MCP server connected</strong>
          <p>
            Add one above, or browse the directory to find one. Nothing is exposed to an agent until
            a server really answers.
          </p>
        </div>
      ) : (
        <div className="skills-browser">
          <aside className="skills-list">
            {servers.map((server) => (
              <button
                key={server.id}
                className={`skill-row ${server.id === selectedId ? 'selected' : ''}`}
                onClick={() => setSelectedId(server.id)}
              >
                <strong>{server.name}</strong>
                <small>{registeredMcpToolIds(server.id).length} tools</small>
              </button>
            ))}
          </aside>
          {selected && (
            <section className="skill-detail" aria-label="Selected MCP server">
              <div className="skill-detail-heading">
                <div>
                  <p className="eyebrow">MCP server</p>
                  <h3>{selected.name}</h3>
                </div>
                <div className="skill-detail-actions">
                  {mcpAuthKind(selected) === 'oauth' && (
                    <button
                      className="row-button"
                      disabled={busy}
                      onClick={() => void signInAgain(selected)}
                    >
                      Sign in again
                    </button>
                  )}
                  <button
                    className="row-button"
                    disabled={busy}
                    onClick={() => void refresh(selected)}
                  >
                    Reconnect
                  </button>
                  <button
                    className="row-button"
                    disabled={busy}
                    onClick={() => void disconnect(selected)}
                  >
                    Remove
                  </button>
                </div>
              </div>
              <dl className="skill-meta">
                <div>
                  <dt>Endpoint</dt>
                  <dd>{selected.url}</dd>
                </div>
                <div>
                  <dt>Authentication</dt>
                  <dd>
                    {mcpAuthKind(selected) === 'oauth'
                      ? 'Signed in · token in OS keyring'
                      : mcpAuthKind(selected) === 'token'
                        ? 'Bearer token in OS keyring'
                        : 'None'}
                  </dd>
                </div>
                <div>
                  <dt>Last verified</dt>
                  <dd>{formatDate(selected.verifiedAt)}</dd>
                </div>
                <div>
                  <dt>Tools available now</dt>
                  <dd>{selectedTools.length}</dd>
                </div>
                <div>
                  <dt>Prompts available now</dt>
                  <dd>{prompts.length}</dd>
                </div>
                <div>
                  <dt>Resources available now</dt>
                  <dd>{resources.length}</dd>
                </div>
                <div>
                  <dt>Resource templates available now</dt>
                  <dd>{resourceTemplates.length}</dd>
                </div>
              </dl>
              {selectedTools.length === 0 ? (
                <p className="skill-summary">
                  No tool from this server is registered right now. Reconnect to discover its tools
                  again; IRIS does not keep tools from a server it cannot reach.
                </p>
              ) : (
                <div className="agent-tool-options">
                  {selectedTools.map((tool) => (
                    <article className="agent-tool-option" key={tool.id}>
                      <div className="agent-tool-assignment">
                        <span>
                          <strong>{tool.name}</strong>
                          <small>{tool.description}</small>
                        </span>
                        <em>{tool.risk}</em>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              <p className="skill-catalog-meta">
                These tools are deny-by-default. Assign them to an agent in Agents and choose Ask,
                Allow or Deny before any of them can run.
              </p>
              <section className="agent-capabilities" aria-label="MCP server requests">
                <p className="eyebrow">Server requests</p>
                <p className="skill-catalog-meta">
                  Requests originate from the MCP server. They stay denied unless you explicitly
                  allow a supported method. Sampling uses only the explicitly selected provider and
                  model below; it never grants the server access to IRIS tools.
                </p>
                {supportedMcpServerRequestMethods.map((method) => (
                  <article className="agent-tool-option" key={method}>
                    <div className="agent-tool-assignment">
                      <span>
                        <strong>{method}</strong>
                        <small>
                          {method === 'roots/list'
                            ? 'Share the mounted workspace root with this server.'
                            : method === 'elicitation/create'
                              ? 'Allow this server to ask for bounded form input.'
                              : 'Allow this server to request bounded text generation from the selected model.'}
                        </small>
                      </span>
                      <select
                        aria-label={`${method} policy`}
                        value={requestPolicies[method] ?? 'deny'}
                        disabled={busy || !native}
                        onChange={(event) => {
                          const decision = event.target.value as 'allow' | 'deny';
                          setRequestPolicies((current) => ({ ...current, [method]: decision }));
                          void setMcpServerRequestPolicy(selected.id, method, decision).catch(
                            (policyError) => {
                              setError(describeMcpError(policyError));
                            },
                          );
                        }}
                      >
                        <option value="deny">Deny</option>
                        <option value="allow">Allow</option>
                      </select>
                    </div>
                  </article>
                ))}
              </section>
              <section className="agent-capabilities" aria-label="MCP sampling configuration">
                <p className="eyebrow">Sampling model</p>
                <p className="skill-catalog-meta">
                  Server-requested sampling is off until you choose a provider and model and allow
                  <code>sampling/createMessage</code> above. Requests are text-only and bounded.
                </p>
                {providerConfigs.length === 0 ? (
                  <p className="skill-summary">No enabled model providers are configured.</p>
                ) : (
                  <div className="skill-editor">
                    <label>
                      <span>Provider</span>
                      <select
                        value={samplingProviderId}
                        disabled={busy || !native}
                        onChange={(event) => {
                          const next = providerConfigs.find(
                            (provider) => provider.id === event.target.value,
                          );
                          const model = next?.model ?? next?.availableModels?.[0] ?? '';
                          setSamplingProviderId(event.target.value);
                          setSamplingModel(model);
                          void configureMcpSampling(selected.id, event.target.value, model).catch(
                            (samplingError) => setError(describeMcpError(samplingError)),
                          );
                        }}
                      >
                        <option value="">Choose a provider…</option>
                        {providerConfigs.map((provider) => (
                          <option value={provider.id} key={provider.id}>
                            {provider.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Model</span>
                      <select
                        value={samplingModel}
                        disabled={busy || !native || !samplingProviderId}
                        onChange={(event) => {
                          setSamplingModel(event.target.value);
                          void configureMcpSampling(
                            selected.id,
                            samplingProviderId,
                            event.target.value,
                          ).catch((samplingError) => setError(describeMcpError(samplingError)));
                        }}
                      >
                        <option value="">Choose a model…</option>
                        {(() => {
                          const provider = providerConfigs.find(
                            (candidate) => candidate.id === samplingProviderId,
                          );
                          const models = provider?.availableModels?.length
                            ? provider.availableModels
                            : provider?.model
                              ? [provider.model]
                              : [];
                          return models.map((model) => (
                            <option value={model} key={model}>
                              {model}
                            </option>
                          ));
                        })()}
                      </select>
                    </label>
                  </div>
                )}
              </section>
              <section className="agent-capabilities" aria-label="MCP prompts">
                <p className="eyebrow">Prompts</p>
                {prompts.length === 0 ? (
                  <p className="skill-summary">
                    This server exposed no prompts, or prompts are currently unavailable.
                  </p>
                ) : (
                  prompts.map((prompt) => {
                    const needsArguments = prompt.arguments.some((argument) => argument.required);
                    return (
                      <article className="agent-tool-option" key={prompt.name}>
                        <div className="agent-tool-assignment">
                          <span>
                            <strong>{prompt.title ?? prompt.name}</strong>
                            <small>{prompt.description}</small>
                            {prompt.arguments.length > 0 && (
                              <div className="mcp-prompt-arguments">
                                {prompt.arguments.map((argument) => {
                                  const key = `${prompt.name}:${argument.name}`;
                                  return (
                                    <label key={argument.name}>
                                      <span>
                                        {argument.name}
                                        {argument.required ? ' · required' : ''}
                                      </span>
                                      <input
                                        value={promptArgumentValues[key] ?? ''}
                                        placeholder={argument.description || 'Value'}
                                        onChange={(event) =>
                                          setPromptArgumentValues((current) => ({
                                            ...current,
                                            [key]: event.target.value,
                                          }))
                                        }
                                      />
                                      <button
                                        className="row-button"
                                        disabled={busy}
                                        onClick={() => {
                                          setCompletionPreview('Loading completions…');
                                          void completeMcp(selected.id, {
                                            ref: { type: 'ref/prompt', name: prompt.name },
                                            argument: {
                                              name: argument.name,
                                              value: promptArgumentValues[key] ?? '',
                                            },
                                          })
                                            .then((result) =>
                                              setCompletionPreview(
                                                result.values.length
                                                  ? `${argument.name}: ${result.values.join(', ')}${result.hasMore ? ' · more available' : ''}`
                                                  : `${argument.name}: The server returned no suggestions.`,
                                              ),
                                            )
                                            .catch((error) =>
                                              setCompletionPreview(describeMcpError(error)),
                                            );
                                        }}
                                      >
                                        Complete
                                      </button>
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                          </span>
                          <button
                            className="row-button"
                            disabled={busy || needsArguments}
                            onClick={() => {
                              setPromptPreview('Loading prompt…');
                              void getMcpPrompt(selected.id, prompt.name)
                                .then((result) =>
                                  setPromptPreview(
                                    result.messages
                                      .map((message) => `${message.role}: ${message.text}`)
                                      .join('\n\n') || 'The prompt returned no text messages.',
                                  ),
                                )
                                .catch((error) => setPromptPreview(describeMcpError(error)));
                            }}
                          >
                            {needsArguments ? 'Needs arguments' : 'Inspect'}
                          </button>
                        </div>
                      </article>
                    );
                  })
                )}
                {promptPreview && <pre className="skill-instructions">{promptPreview}</pre>}
                {completionPreview && <pre className="skill-instructions">{completionPreview}</pre>}
              </section>
              <section className="agent-capabilities" aria-label="MCP resources">
                <p className="eyebrow">Resources</p>
                {resources.length === 0 ? (
                  <p className="skill-summary">
                    This server exposed no resources, or resources are currently unavailable.
                  </p>
                ) : (
                  resources.map((resource) => (
                    <article className="agent-tool-option" key={resource.uri}>
                      <div className="agent-tool-assignment">
                        <span>
                          <strong>{resource.title ?? resource.name}</strong>
                          <small>{resource.description}</small>
                          <small>
                            {resource.mimeType ?? 'Unknown type'}
                            {resource.size !== undefined
                              ? ` · ${resource.size.toLocaleString()} bytes`
                              : ''}
                          </small>
                        </span>
                        <button
                          className="row-button"
                          disabled={busy}
                          onClick={() => {
                            setResourcePreview('Loading resource…');
                            void readMcpResource(selected.id, resource.uri)
                              .then((result) =>
                                setResourcePreview(
                                  result.contents
                                    .map(
                                      (content) =>
                                        content.text ??
                                        `[Binary ${content.mimeType ?? 'resource'} content is not rendered]`,
                                    )
                                    .join('\n\n') || 'The resource returned no readable content.',
                                ),
                              )
                              .catch((readError) =>
                                setResourcePreview(describeMcpError(readError)),
                              );
                          }}
                        >
                          Inspect
                        </button>
                      </div>
                      <small className="skill-catalog-meta">{resource.uri}</small>
                    </article>
                  ))
                )}
                {resourcePreview && <pre className="skill-instructions">{resourcePreview}</pre>}
                <p className="skill-catalog-meta">
                  Resources are read-only server content. They are not tools, are not assigned to
                  agents and grant no execution authority.
                </p>
              </section>
              <section className="agent-capabilities" aria-label="MCP resource templates">
                <p className="eyebrow">Resource templates</p>
                {resourceTemplates.length === 0 ? (
                  <p className="skill-summary">
                    This server exposed no resource templates, or templates are currently
                    unavailable.
                  </p>
                ) : (
                  resourceTemplates.map((template) => (
                    <article className="agent-tool-option" key={template.uriTemplate}>
                      <div className="agent-tool-assignment">
                        <span>
                          <strong>{template.title ?? template.name}</strong>
                          <small>{template.description}</small>
                          <small>{template.mimeType ?? 'Unknown type'}</small>
                        </span>
                      </div>
                      <small className="skill-catalog-meta">{template.uriTemplate}</small>
                    </article>
                  ))
                )}
                <p className="skill-catalog-meta">
                  Templates are read-only server metadata. IRIS does not expand or fetch them
                  automatically, and they are not tools or agent authority.
                </p>
              </section>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
