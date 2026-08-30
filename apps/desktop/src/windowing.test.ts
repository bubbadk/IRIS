import { describe, expect, it } from 'vitest';
import {
  defaultWindow,
  moveWindow,
  normalizeWindow,
  resizeWindow,
  windowLayerBase,
} from './windowing';

describe('desktop window bounds', () => {
  it('keeps restored windows inside the interactive desktop layer', () => {
    const restored = normalizeWindow({
      id: 'settings-1',
      objectType: 'settings',
      title: 'System Permissions',
      x: -40,
      y: -70,
      width: 200,
      height: 100,
      z: 1,
    });
    expect(restored).toMatchObject({
      x: 14,
      y: 70,
      width: 360,
      height: 260,
      z: windowLayerBase,
    });
  });

  it('opens the permission workbench with room for its real controls', () => {
    expect(defaultWindow('settings', windowLayerBase + 1)).toMatchObject({
      title: 'System Permissions',
      width: 680,
      height: 560,
    });
  });

  it('opens a project graph with enough room for its spatial work surface', () => {
    expect(defaultWindow('projects', windowLayerBase + 1)).toMatchObject({
      title: 'Projects',
      width: 760,
      height: 560,
    });
  });

  it('calculates bounded movement without mutating the source window', () => {
    const source = defaultWindow('agents', windowLayerBase + 1);
    const moved = moveWindow(source, 5, 8, 40, 20);

    expect(moved).toMatchObject({ x: 14, y: 70 });
    expect(source).not.toBe(moved);
    expect(source.x).not.toBe(moved.x);
  });

  it('calculates bounded resizing from the interaction start size', () => {
    const source = defaultWindow('agents', windowLayerBase + 1);

    expect(resizeWindow(source, 120, 80)).toMatchObject({
      width: source.width + 120,
      height: source.height + 80,
    });
    expect(resizeWindow(source, -1_000, -1_000)).toMatchObject({
      width: 360,
      height: 260,
    });
  });
});
