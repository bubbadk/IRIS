import { describe, expect, it } from 'vitest';
import { DesktopWidget } from './DesktopWidget';

describe('DesktopWidget component export & semantics', () => {
  it('exports a valid React functional component', () => {
    expect(typeof DesktopWidget).toBe('function');
  });
});
