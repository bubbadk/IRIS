import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  authorizationServerMetadataUrls,
  buildAuthorizationUrl,
  parseAuthorizationServerMetadata,
  parseClientRegistration,
  parseProtectedResourceMetadata,
  parseTokenResponse,
  protectedResourceMetadataUrls,
  tokensAreFresh,
  type McpAuthorizationServerMetadata,
  type McpOAuthClient,
  type McpOAuthTokens,
} from '@iris/mcp';
import { isTauriRuntime } from './credentials';

interface OAuthHttpResponse {
  status: number;
  body: string;
}

interface OAuthCallback {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

function requireNative(): void {
  if (!isTauriRuntime()) {
    throw new Error('Signing in to an MCP server requires the native IRIS desktop app.');
  }
}

function parseJson(response: OAuthHttpResponse, label: string): unknown {
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new Error(`The ${label} returned a response that is not JSON.`);
  }
}

async function getJson(url: string, label: string): Promise<unknown> {
  requireNative();
  const response = await invoke<OAuthHttpResponse>('oauth_get', { url });
  if (response.status >= 400) {
    throw new Error(`The ${label} answered HTTP ${response.status}.`);
  }
  return parseJson(response, label);
}

/** Random, URL-safe, and long enough that a value cannot be guessed by a page that sees the redirect. */
function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64Url(buffer);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export interface McpOAuthDiscovery {
  resourceMetadataUrl: string;
  resource: string;
  metadata: McpAuthorizationServerMetadata;
  scopes: string[];
}

/**
 * Follows the MCP authorization chain: the challenge names a protected resource document, which
 * names an authorization server, whose metadata carries the endpoints.
 */
export async function discoverAuthorization(
  resourceMetadataUrl: string,
  serverUrl?: string,
  requestedScopes: string[] = [],
  readJson: (url: string, label: string) => Promise<unknown> = getJson,
): Promise<McpOAuthDiscovery> {
  let resourceMetadata: ReturnType<typeof parseProtectedResourceMetadata> | null = null;
  let resolvedResourceMetadataUrl = resourceMetadataUrl;
  let lastResourceError: unknown = null;
  const resourceCandidates = serverUrl
    ? protectedResourceMetadataUrls(serverUrl, resourceMetadataUrl)
    : [resourceMetadataUrl];
  for (const candidate of resourceCandidates) {
    try {
      resourceMetadata = parseProtectedResourceMetadata(await readJson(candidate, 'MCP server'));
      resolvedResourceMetadataUrl = candidate;
      break;
    } catch (error) {
      lastResourceError = error;
    }
  }
  if (!resourceMetadata) {
    throw new Error(
      `IRIS could not read protected-resource metadata: ${
        lastResourceError instanceof Error ? lastResourceError.message : String(lastResourceError)
      }`,
    );
  }
  const issuer = resourceMetadata.authorizationServers[0]!;

  let lastError: unknown = null;
  for (const candidate of authorizationServerMetadataUrls(issuer)) {
    try {
      const metadata = parseAuthorizationServerMetadata(
        await readJson(candidate, 'authorization server'),
      );
      if (metadata.issuer !== issuer) {
        throw new Error(
          `The authorization metadata issuer ${metadata.issuer} does not match ${issuer}.`,
        );
      }
      if (!metadata.supportsPkce) {
        throw new Error(
          'The authorization server does not advertise the required PKCE S256 method.',
        );
      }
      return {
        resourceMetadataUrl: resolvedResourceMetadataUrl,
        resource: resourceMetadata.resource || issuer,
        metadata,
        scopes: requestedScopes.length
          ? [...new Set(requestedScopes)]
          : resourceMetadata.scopesSupported.length
            ? resourceMetadata.scopesSupported
            : metadata.scopesSupported,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `IRIS could not read authorization metadata from ${issuer}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * MCP authorization servers rarely have a pre-registered IRIS client, so one is registered on the
 * spot. A public client with PKCE is requested, which is why no secret is expected back.
 */
export async function registerClient(
  metadata: McpAuthorizationServerMetadata,
  redirectUri: string,
): Promise<McpOAuthClient> {
  if (!metadata.registrationEndpoint) {
    throw new Error(
      'This authorization server does not offer dynamic client registration, so IRIS cannot sign in to it automatically.',
    );
  }
  requireNative();
  const response = await invoke<OAuthHttpResponse>('oauth_post_json', {
    url: metadata.registrationEndpoint,
    body: JSON.stringify({
      client_name: 'IRIS',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (response.status >= 400) {
    throw new Error(
      `The authorization server refused to register IRIS (HTTP ${response.status}). ${response.body.slice(0, 200)}`,
    );
  }
  return parseClientRegistration(parseJson(response, 'authorization server'));
}

async function exchange(
  metadata: McpAuthorizationServerMetadata,
  form: Record<string, string>,
): Promise<McpOAuthTokens> {
  requireNative();
  const response = await invoke<OAuthHttpResponse>('oauth_post_form', {
    url: metadata.tokenEndpoint,
    form,
  });
  const payload = parseJson(response, 'authorization server');
  if (response.status >= 400) {
    // The body usually explains the refusal better than the status does.
    return parseTokenResponse(payload, Date.now());
  }
  return parseTokenResponse(payload, Date.now());
}

export interface McpSignInResult {
  tokens: McpOAuthTokens;
  client: McpOAuthClient;
  discovery: McpOAuthDiscovery;
}

/**
 * Runs the full authorization-code flow with PKCE against a loopback redirect. The browser is opened
 * for the user to consent; nothing is stored unless a real token comes back.
 */
export async function signIn(
  resourceMetadataUrl: string,
  onStatus: (message: string) => void = () => undefined,
  serverUrl?: string,
  requestedScopes: string[] = [],
  configuredClient?: McpOAuthClient,
): Promise<McpSignInResult> {
  requireNative();
  onStatus('Reading the server’s authorization metadata…');
  const discovery = await discoverAuthorization(resourceMetadataUrl, serverUrl, requestedScopes);

  const port = await invoke<number>('oauth_start_listener');
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    onStatus(configuredClient ? 'Using the configured OAuth client…' : 'Registering IRIS with the authorization server…');
    const client = configuredClient ?? await registerClient(discovery.metadata, redirectUri);

    const state = randomToken(16);
    const codeVerifier = randomToken(48);
    const authorizationUrl = buildAuthorizationUrl({
      metadata: discovery.metadata,
      client,
      redirectUri,
      state,
      codeChallenge: await pkceChallenge(codeVerifier),
      scopes: discovery.scopes,
      resource: discovery.resource,
    });

    onStatus('Waiting for you to approve the sign-in in your browser…');
    await openUrl(authorizationUrl);
    const callback = await invoke<OAuthCallback>('oauth_await_callback', { port });

    if (callback.error) {
      throw new Error(
        `The sign-in was refused: ${callback.error}${callback.errorDescription ? ` — ${callback.errorDescription}` : ''}`,
      );
    }
    if (callback.state !== state) {
      throw new Error('The sign-in came back with the wrong state value and was discarded.');
    }
    if (!callback.code) {
      throw new Error('The sign-in returned no authorization code.');
    }

    onStatus('Exchanging the authorization code for a token…');
    const tokens = await exchange(discovery.metadata, {
      grant_type: 'authorization_code',
      code: callback.code,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      code_verifier: codeVerifier,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      ...(discovery.resource ? { resource: discovery.resource } : {}),
    });
    return { tokens, client, discovery };
  } catch (error) {
    await invoke('oauth_cancel_listener', { port }).catch(() => undefined);
    throw error;
  }
}

export async function refreshTokens(
  metadata: McpAuthorizationServerMetadata,
  client: McpOAuthClient,
  tokens: McpOAuthTokens,
  resource?: string,
): Promise<McpOAuthTokens> {
  if (!tokens.refreshToken) {
    throw new Error('This connection has no refresh token, so it must be signed in again.');
  }
  const refreshed = await exchange(metadata, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    ...(resource ? { resource } : {}),
  });
  // Servers may omit the refresh token on rotation, in which case the existing one stays valid.
  return refreshed.refreshToken ? refreshed : { ...refreshed, refreshToken: tokens.refreshToken };
}

export { tokensAreFresh };
