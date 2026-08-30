import { describe, expect, it } from 'vitest';
import { scheduleDateLabel } from './SchedulesState';

describe('scheduleDateLabel', () => {
  it('formats a run in the schedule timezone instead of the browser timezone', () => {
    const label = scheduleDateLabel('2026-08-28T07:30:00.000Z', 'Europe/Copenhagen');

    // Copenhagen is UTC+2 in August, so the run reads 09:30 there, not 07:30 UTC.
    // Match locale-independently: da-DK renders "09.30", en-US renders "9:30 AM".
    expect(label).toMatch(/0?9[.:]30/);
    expect(label).not.toMatch(/0?7[.:]30/);
  });
});
