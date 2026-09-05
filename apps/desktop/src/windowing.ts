import type { IrisObjectType } from '@iris/core';

export type DesktopWindow = {
  id: string;
  objectType: IrisObjectType | 'welcome';
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
};

const key = 'iris.desktop.windows.v1';
export const windowLayerBase = 10;

export interface DesktopBounds { width: number; height: number; }

export function normalizeWindow(win: DesktopWindow, bounds?: DesktopBounds): DesktopWindow {
  const viewport = bounds ?? (typeof window !== 'undefined' ? { width: window.innerWidth, height: window.innerHeight } : undefined);
  const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
  const maxWidth = viewport ? Math.max(100, viewport.width - 28) : Infinity;
  const maxHeight = viewport ? Math.max(100, viewport.height - 84) : Infinity;
  const width = Math.min(maxWidth, Math.max(360, finite(win.width, 520)));
  const height = Math.min(maxHeight, Math.max(260, finite(win.height, 390)));
  return {
    ...win, width, height,
    x: Math.max(14, Math.min(finite(win.x, 14), viewport ? viewport.width - width - 14 : Infinity)),
    y: Math.max(70, Math.min(finite(win.y, 70), viewport ? viewport.height - height - 14 : Infinity)),
    z: Math.max(windowLayerBase, finite(win.z, windowLayerBase)),
  };
}

export function moveWindow(
  win: DesktopWindow,
  pointerX: number,
  pointerY: number,
  grabX: number,
  grabY: number,
): DesktopWindow {
  return normalizeWindow({
    ...win,
    x: pointerX - grabX,
    y: pointerY - grabY,
  });
}

export function resizeWindow(
  win: DesktopWindow,
  deltaWidth: number,
  deltaHeight: number,
): DesktopWindow {
  return normalizeWindow({
    ...win,
    width: win.width + deltaWidth,
    height: win.height + deltaHeight,
  });
}

export function loadWindows(): DesktopWindow[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DesktopWindow[];
    return Array.isArray(parsed) ? parsed.filter(isDesktopWindow).map((win) => normalizeWindow(win)) : [];
  } catch {
    return [];
  }
}

export function saveWindows(windows: DesktopWindow[]) {
  localStorage.setItem(key, JSON.stringify(windows));
}

export function defaultWindow(objectType: DesktopWindow['objectType'], z: number): DesktopWindow {
  const title =
    objectType === 'welcome'
      ? 'Welcome to IRIS'
      : objectType === 'settings'
        ? 'System Permissions'
        : objectType === 'subtitles'
          ? 'Subtitle Studio'
          : objectType[0].toUpperCase() + objectType.slice(1);
  const offset = Math.min(z * 22, 132);
  return {
    id: `${objectType}-${crypto.randomUUID()}`,
    objectType,
    title,
    x: 180 + offset,
    y: 120 + offset / 2,
    width:
      objectType === 'welcome'
        ? 560
        : objectType === 'github'
          ? 920
          : objectType === 'subtitles'
            ? 880
            : objectType === 'settings' ||
              objectType === 'memory' ||
              objectType === 'projects' ||
              objectType === 'schedules' ||
              objectType === 'workspace' || objectType === 'channels'
            ? objectType === 'projects' || objectType === 'workspace' || objectType === 'channels'
              ? 760
              : 680
            : objectType === 'agents' ? 860 : 520,
    height:
      objectType === 'welcome'
        ? 360
        : objectType === 'github'
          ? 640
          : objectType === 'subtitles'
            ? 580
            : objectType === 'settings' ||
              objectType === 'memory' ||
              objectType === 'projects' ||
              objectType === 'schedules' ||
              objectType === 'workspace' || objectType === 'channels'
            ? 560
            : objectType === 'agents' ? 620 : 390,
    z,
  };
}


function isDesktopWindow(value: unknown): value is DesktopWindow {
  if (!value || typeof value !== 'object') return false;
  const win = value as Partial<DesktopWindow>;
  return typeof win.id === 'string' && typeof win.title === 'string' &&
    ['welcome', 'agents', 'projects', 'schedules', 'workspace', 'models', 'memory', 'skills', 'subtitles', 'connections', 'channels', 'settings', 'github', 'systems'].includes(win.objectType ?? '') &&
    [win.x, win.y, win.width, win.height, win.z].every((n) => typeof n === 'number' && Number.isFinite(n));
}

const layoutsKey = 'iris.desktop.layouts.v1';
export function loadLayouts(): Record<string, DesktopWindow[]> {
  const raw = localStorage.getItem(layoutsKey);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Saved layouts could not be read.');
  return Object.fromEntries(Object.entries(parsed).filter(([, windows]) => Array.isArray(windows) && windows.every(isDesktopWindow)));
}

export function saveLayout(name: string, windows: DesktopWindow[]): void {
  if (!name.trim()) throw new Error('Enter a layout name.');
  localStorage.setItem(layoutsKey, JSON.stringify({ ...loadLayouts(), [name.trim()]: windows }));
}
