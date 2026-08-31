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

export function normalizeWindow(win: DesktopWindow): DesktopWindow {
  return {
    ...win,
    x: Math.max(14, win.x),
    y: Math.max(70, win.y),
    width: Math.max(360, win.width),
    height: Math.max(260, win.height),
    z: Math.max(windowLayerBase, win.z),
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
    return Array.isArray(parsed) ? parsed.map(normalizeWindow) : [];
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
          : objectType === 'settings' ||
              objectType === 'memory' ||
              objectType === 'projects' ||
              objectType === 'schedules' ||
              objectType === 'workspace'
            ? objectType === 'projects' || objectType === 'workspace'
              ? 760
              : 680
            : objectType === 'agents' ? 860 : 520,
    height:
      objectType === 'welcome'
        ? 360
        : objectType === 'github'
          ? 640
          : objectType === 'settings' ||
              objectType === 'memory' ||
              objectType === 'projects' ||
              objectType === 'schedules' ||
              objectType === 'workspace'
            ? 560
            : objectType === 'agents' ? 620 : 390,
    z,
  };
}
