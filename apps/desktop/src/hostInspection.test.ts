import { describe, expect, it, vi } from 'vitest';
import { createHostInspectionTool } from './hostInspection';

describe('native host inspection tool', () => {
  it('returns validated native host facts', async () => {
    const invokeNative = vi.fn(async () => ({
      operatingSystem: 'linux',
      architecture: 'x86_64',
      appVersion: '0.1.0',
    }));
    const tool = createHostInspectionTool({ available: () => true, invokeNative });
    await expect(tool.run({}, { agentId: 'agent-1', agentName: 'Operator' })).resolves.toEqual({
      operatingSystem: 'linux',
      architecture: 'x86_64',
      appVersion: '0.1.0',
    });
    expect(invokeNative).toHaveBeenCalledWith('inspect_host');
  });

  it('does not invent browser fallback data', async () => {
    const invokeNative = vi.fn(async () => ({}));
    const tool = createHostInspectionTool({ available: () => false, invokeNative });
    await expect(tool.run({}, { agentId: 'agent-1', agentName: 'Operator' })).rejects.toThrow(
      'available only in the native IRIS desktop app',
    );
    expect(invokeNative).not.toHaveBeenCalled();
  });

  it('rejects unexpected invocation input', async () => {
    const tool = createHostInspectionTool({ available: () => true, invokeNative: vi.fn() });
    await expect(
      tool.run({ path: '/tmp' }, { agentId: 'agent-1', agentName: 'Operator' }),
    ).rejects.toThrow('does not accept input');
  });
});
