// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserState } from './BrowserState';
const { inspect, start, takeControl, returnControl, navigate, switchTab, close } = vi.hoisted(
  () => ({
    inspect: vi.fn(),
    start: vi.fn(),
    takeControl: vi.fn(),
    returnControl: vi.fn(),
    navigate: vi.fn(),
    switchTab: vi.fn(),
    close: vi.fn(),
  }),
);
vi.mock('./browserSession', () => ({
  browserSession: {
    available: () => true,
    inspect,
    start,
    takeControl,
    returnControl,
    navigate,
    switchTab,
    close,
  },
  subscribeBrowser: () => () => undefined,
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
it('waits for a real handover result before claiming user ownership and reports failures', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const page = {
    url: 'http://localhost/test',
    title: 'Browser verification',
    elements: [],
    textSummary: '',
  };
  inspect.mockResolvedValue({
    running: true,
    visible: true,
    userControl: false,
    page,
    screenshot: null,
    tabs: [
      { id: 'tab-one', active: true },
      { id: 'tab-two', active: false },
    ],
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  const button = (name: string) =>
    [...container.querySelectorAll('button')].find((element) => element.textContent === name)!;
  await act(async () => root.render(<BrowserState />));
  let complete!: () => void;
  takeControl.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () => button('Take control').click());
  expect(container.textContent).toContain('Waiting for the already dispatched browser action');
  expect(container.textContent).not.toContain('You have control');
  expect(button('Take control').disabled).toBe(true);
  inspect.mockResolvedValue({
    running: true,
    visible: true,
    userControl: true,
    page,
    screenshot: null,
  });
  await act(async () => complete());
  expect(container.textContent).toContain('You have control');
  returnControl.mockRejectedValue(new Error('Browser driver stopped.'));
  await act(async () => button('Return control to agents').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Browser driver stopped.',
  );
  expect(container.textContent).toContain('You have control');
  expect(button('Close browser session').disabled).toBe(false);
  await act(async () => root.unmount());
});
it('navigates through the permission-controlled browser session', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const page = {
    url: 'https://example.com/',
    title: 'Example',
    elements: [],
    textSummary: '',
  };
  inspect.mockResolvedValue({
    running: true,
    visible: true,
    userControl: false,
    page,
    screenshot: null,
    tabs: [
      { id: 'tab-one', active: true },
      { id: 'tab-two', active: false },
    ],
  });
  navigate.mockResolvedValue({ ...page, url: 'https://iris.local/' });
  switchTab.mockResolvedValue(page);
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<BrowserState />));
  const input = container.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'https://iris.local/',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLFormElement>('form')!.requestSubmit());
  expect(navigate).toHaveBeenCalledWith('https://iris.local/');
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Tab 2')!
      .click(),
  );
  expect(switchTab).toHaveBeenCalledWith('tab-two');
  await act(async () => root.unmount());
});
