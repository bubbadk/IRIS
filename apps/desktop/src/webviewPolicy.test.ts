// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Phase 2I.4 regression suite — the webview Content-Security-Policy.
 *
 * `app.security.csp` was `null`, so the privileged webview (which can invoke every application
 * `#[tauri::command]`) carried no second barrier behind the renderer. This suite pins the policy
 * that replaced it: it must exist, it must actually restrict the directives that matter, and it
 * must not buy that restriction with `unsafe-eval` or a bare `*`.
 *
 * The policy's *compatibility* is not asserted here — it is verified by booting the release binary
 * and confirming it initializes through the real IPC transport (see the phase report). This suite
 * guards against silent removal or loosening of the policy, which no runtime test would notice.
 */

const config = JSON.parse(
  readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
) as {
  app: { security: { csp: string | null; devCsp?: string | null } };
  plugins: { updater: { pubkey?: string } };
};

const csp = config.app.security.csp;

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...sources] = part.split(/\s+/);
        return [name!, sources];
      }),
  );
}

describe('webview Content-Security-Policy', () => {
  it('is configured (not null) for the production webview', () => {
    expect(csp).toBeTypeOf('string');
    expect(csp!.trim().length).toBeGreaterThan(0);
  });

  it('restricts scripts to the application bundle with no eval and no inline escape hatch', () => {
    const map = directives(csp!);
    const scriptSrc = map.get('script-src');
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain('*');
    // `default-src` must not be a wildcard either, so any directive that is not listed explicitly
    // still fails closed.
    expect(map.get('default-src')).toEqual(["'self'"]);
  });

  it('blocks plugins, base-tag rewriting and form submission, which the app never uses', () => {
    const map = directives(csp!);
    expect(map.get('object-src')).toEqual(["'none'"]);
    expect(map.get('base-uri')).toEqual(["'none'"]);
    expect(map.get('form-action')).toEqual(["'none'"]);
  });

  it('permits exactly the transports the application actually uses', () => {
    const map = directives(csp!);
    // Tauri documents `ipc:`/`http://ipc.localhost` as the IPC transport origin.
    expect(map.get('connect-src')).toEqual(
      expect.arrayContaining(["'self'", 'ipc:', 'http://ipc.localhost']),
    );
    // Telegram polling/acknowledgement, Discord webhooks and the raw GitHub avatar are direct
    // `fetch`/`img` requests from the webview, so https must stay reachable.
    expect(map.get('connect-src')).toContain('https:');
    expect(map.get('img-src')).toEqual(
      expect.arrayContaining(["'self'", 'data:', 'blob:', 'https:']),
    );
    // Styles and fonts are bundled locally; no external style or font host is part of the build.
    expect(map.get('style-src')).toEqual(["'self'"]);
    expect(map.get('font-src')).toEqual(expect.arrayContaining(["'self'", 'data:']));
  });

  it('keeps the updater public key intact alongside the policy', () => {
    // The updater plugin panics at startup if `pubkey` is missing; a config edit must not drop it.
    expect(config.plugins.updater.pubkey).toBeTypeOf('string');
    expect(config.plugins.updater.pubkey!.length).toBeGreaterThan(100);
  });

  it('does not define a laxer development-only policy', () => {
    // `devCsp` overrides the production policy when set. Keeping it unset means development and
    // production run the same policy, so a policy that only works in one of them fails loudly.
    expect(config.app.security.devCsp ?? null).toBeNull();
  });
});
