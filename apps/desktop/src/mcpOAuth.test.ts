import { describe, expect, it } from 'vitest';
import { discoverAuthorization } from './mcpOAuth';

describe('MCP OAuth discovery interoperability', () => {
  it('recovers from stale challenged metadata through the endpoint-specific RFC 9728 URI', async () => {
    const calls: string[] = [];
    const readJson = async (url: string): Promise<unknown> => {
      calls.push(url);
      if (url === 'https://api.newzai.example/.well-known/oauth-protected-resource') {
        throw new Error('HTTP 404');
      }
      if (url === 'https://api.newzai.example/.well-known/oauth-protected-resource/mcp') {
        return {
          resource: 'https://api.newzai.example/mcp',
          authorization_servers: ['https://api.newzai.example/'],
          scopes_supported: ['openid', 'profile'],
        };
      }
      if (url === 'https://api.newzai.example/.well-known/oauth-authorization-server') {
        return {
          issuer: 'https://api.newzai.example/',
          authorization_endpoint: 'https://api.newzai.example/authorize',
          token_endpoint: 'https://api.newzai.example/token',
          registration_endpoint: 'https://api.newzai.example/register',
          code_challenge_methods_supported: ['S256'],
        };
      }
      throw new Error(`Unexpected metadata URL: ${url}`);
    };

    const discovery = await discoverAuthorization(
      'https://api.newzai.example/.well-known/oauth-protected-resource',
      'https://api.newzai.example/mcp',
      ['news:read'],
      readJson,
    );

    expect(calls.slice(0, 2)).toEqual([
      'https://api.newzai.example/.well-known/oauth-protected-resource',
      'https://api.newzai.example/.well-known/oauth-protected-resource/mcp',
    ]);
    expect(discovery).toMatchObject({
      resourceMetadataUrl: 'https://api.newzai.example/.well-known/oauth-protected-resource/mcp',
      resource: 'https://api.newzai.example/mcp',
      scopes: ['news:read'],
      metadata: { issuer: 'https://api.newzai.example/', supportsPkce: true },
    });
  });

  it('refuses metadata that cannot prove PKCE S256 support', async () => {
    const readJson = async (url: string): Promise<unknown> => {
      if (url.includes('oauth-protected-resource')) {
        return {
          resource: 'https://mcp.example/mcp',
          authorization_servers: ['https://auth.example/'],
        };
      }
      return {
        issuer: 'https://auth.example/',
        authorization_endpoint: 'https://auth.example/authorize',
        token_endpoint: 'https://auth.example/token',
      };
    };

    await expect(
      discoverAuthorization(
        'https://mcp.example/.well-known/oauth-protected-resource/mcp',
        'https://mcp.example/mcp',
        [],
        readJson,
      ),
    ).rejects.toThrow(/PKCE S256/);
  });
});
