import { invoke, isTauri } from '@tauri-apps/api/core';
import type { BrowserPageState } from './liveBrowserTools';
export interface BrowserInspection {
  running: boolean;
  visible: boolean;
  userControl: boolean;
  page: BrowserPageState | null;
  screenshot: string | null;
  tabs: { id: string; active: boolean }[];
}
const listeners = new Set<() => void>();
export function notifyBrowserChanged() {
  listeners.forEach((listener) => listener());
}
export function subscribeBrowser(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const browserSession = {
  available: () => isTauri(),
  inspect: () => invoke<BrowserInspection>('browser_inspect'),
  start: () => invoke<BrowserPageState>('browser_start', { visible: true }),
  takeControl: () => invoke<BrowserInspection>('browser_take_control'),
  returnControl: () => invoke<BrowserInspection>('browser_return_control'),
  navigate: (url: string) => invoke<BrowserPageState>('browser_navigate', { url }),
  switchTab: (tabId: string) => invoke<BrowserPageState>('browser_switch_tab', { tabId }),
  close: () => invoke('browser_close_from_ui'),
};
