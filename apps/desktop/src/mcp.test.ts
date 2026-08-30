import { describe, expect, it } from 'vitest';
import { McpAuthorizationError, McpOAuthTokenError, type McpServerConnection } from '@iris/mcp';
import {
  McpReauthorizationRequiredError,
  mcpReauthorizationError,
  parseMcpOAuthCredentials,
} from './mcp';

const oauthServer: McpServerConnection = {
  version: 1,
  id: 'mcp-gmail',
  name: 'Gmail',
  url: 'https://gmail.example.com/mcp',
  hasToken: true,
  auth: 'oauth',
  oauth: {
    resourceMetadataUrl: 'https://gmail.example.com/.well-known/oauth-protected-resource',
    resource: 'https://gmail.example.com',
    issuer: 'https://auth.example.com',
    authorizationEndpoint: 'https://auth.example.com/authorize',
    tokenEndpoint: 'https://auth.example.com/token',
    registrationEndpoint: 'https://auth.example.com/register',
    clientId: 'iris-client',
    scopes: ['mail.read'],
    signedInAt: '2026-08-28T10:00:00.000Z',
  },
  createdAt: '2026-08-28T10:00:00.000Z',
  verifiedAt: '2026-08-28T10:00:00.000Z',
};

describe('MCP connection recovery', () => {
  it('turns a fresh authorization challenge into an actionable sign-in state', () => {
    const error = mcpReauthorizationError(
      oauthServer,
      new McpAuthorizationError(
        401,
        'Bearer resource_metadata="https://gmail.example.com/new-resource-metadata", scope="mail.read mail.send"',
      ),
    );

    expect(error).toBeInstanceOf(McpReauthorizationRequiredError);
    expect(error).toMatchObject({
      serverId: oauthServer.id,
      resourceMetadataUrl: 'https://gmail.example.com/new-resource-metadata',
      scopes: ['mail.read', 'mail.send'],
    });
    expect(error?.message).toMatch(/sign in again from Connections/);
  });

  it('uses the saved discovery document when a refresh token is revoked', () => {
    const error = mcpReauthorizationError(
      oauthServer,
      new McpOAuthTokenError('invalid_grant', 'refresh token revoked'),
    );

    expect(error?.resourceMetadataUrl).toBe(oauthServer.oauth?.resourceMetadataUrl);
  });

  it('does not misreport an outage or a static bearer-token failure as OAuth consent', () => {
    expect(mcpReauthorizationError(oauthServer, new Error('network down'))).toBeNull();
    expect(
      mcpReauthorizationError(
        { ...oauthServer, auth: 'token', oauth: undefined },
        new McpAuthorizationError(401),
      ),
    ).toBeNull();
  });
});

describe('MCP OAuth credential persistence', () => {
  it('keeps a dynamically registered client secret beside tokens in the keyring payload', () => {
    expect(
      parseMcpOAuthCredentials(
        JSON.stringify({
          version: 1,
          tokens: { accessToken: 'access', refreshToken: 'refresh' },
          clientSecret: 'registered-secret',
        }),
      ),
    ).toEqual({
      version: 1,
      tokens: { accessToken: 'access', refreshToken: 'refresh' },
      clientSecret: 'registered-secret',
    });
  });

  it('migrates the previous token-only keyring payload and rejects unreadable state', () => {
    expect(parseMcpOAuthCredentials(JSON.stringify({ accessToken: 'legacy' }))).toEqual({
      version: 1,
      tokens: { accessToken: 'legacy' },
    });
    expect(parseMcpOAuthCredentials('{}')).toBeNull();
    expect(parseMcpOAuthCredentials('not json')).toBeNull();
  });
});
