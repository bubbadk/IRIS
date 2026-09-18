// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '@iris/core';

const { listAgents, listRules } = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listRules: vi.fn(async () => []),
}));

vi.mock('./persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./persistence')>();
  const withList = <T extends object>(target: T, replacement: unknown): T =>
    new Proxy(target, {
      get: (inner, property) =>
        property === 'list' ? replacement : Reflect.get(inner, property),
    });
  return {
    ...actual,
    agentRepository: withList(actual.agentRepository, listAgents),
    permissionRuleRepository: withList(actual.permissionRuleRepository, listRules),
  };
});

import { AgentsState } from './AgentsState';

const technician: AgentDefinition = {
  id: 'agent-technician',
  name: 'Tekniker',
  autonomy: 'assist',
  skillIds: [],
  toolIds: [],
};

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  // jsdom has no layout, so the conversation scroller needs a no-op.
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {},
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  listAgents.mockReset();
  listRules.mockResolvedValue([]);
});

it('names the failure instead of staying on "Loading agents…"', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  listAgents.mockRejectedValue(
    new Error('record 2 of 3 failed agent configurations validation'),
  );
  const container = document.createElement('div');
  document.body.append(container);
  await act(async () => createRoot(container).render(<AgentsState />));

  expect(container.textContent).toContain('The agent workspace could not be read');
  expect(container.textContent).toContain('record 2 of 3 failed agent configurations validation');
  expect(container.textContent).toContain('Nothing was deleted by this failure');
  expect(container.textContent).not.toContain('Loading agents…');
});

it('reads the workspace again when the user retries', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  listAgents.mockRejectedValueOnce(new Error('The repository database is busy in another window.'));
  listAgents.mockResolvedValue([technician]);
  const container = document.createElement('div');
  document.body.append(container);
  await act(async () => createRoot(container).render(<AgentsState />));
  expect(container.textContent).toContain('The agent workspace could not be read');

  const retry = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Try again',
  );
  expect(retry).toBeDefined();
  await act(async () => retry!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

  expect(container.textContent).toContain('Tekniker');
  expect(container.textContent).not.toContain('The agent workspace could not be read');
});
