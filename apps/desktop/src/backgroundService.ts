import { invoke, isTauri } from '@tauri-apps/api/core';

export interface BackgroundServiceStatus {
  installed: boolean;
  enabled: boolean;
  active: boolean;
  message: string;
}

const unavailable: BackgroundServiceStatus = {
  installed: false,
  enabled: false,
  active: false,
  message: 'Background runtime is available only in the native Linux desktop app.',
};

export async function readBackgroundServiceStatus(): Promise<BackgroundServiceStatus> {
  if (!isTauri()) return unavailable;
  return invoke<BackgroundServiceStatus>('background_service_status');
}

export async function installBackgroundService(): Promise<BackgroundServiceStatus> {
  if (!isTauri()) throw new Error(unavailable.message);
  return invoke<BackgroundServiceStatus>('install_background_service');
}

export async function removeBackgroundService(): Promise<void> {
  if (!isTauri()) throw new Error(unavailable.message);
  await invoke('remove_background_service');
}
