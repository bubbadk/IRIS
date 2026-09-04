import { describe, expect, it } from 'vitest';
import { createShellExecTool } from './shellTool';

describe('workspace shell permission policy', () => {
  it('always requires approval so publication commands cannot bypass GitHub safeguards', () => {
    const tool = createShellExecTool();
    expect(tool.alwaysRequireApproval).toBe(true);
  });
});
