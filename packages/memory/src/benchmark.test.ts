import { describe, expect, it } from 'vitest';
import { runRealMemoryBenchmark } from './benchmark';
import { LocalLexicalMemoryRetriever } from './index';

describe('runRealMemoryBenchmark', () => {
  it('executes official 262-question FP-AMB benchmark against LocalLexicalMemoryRetriever and measures latency', async () => {
    const retriever = new LocalLexicalMemoryRetriever();
    const progressUpdates: number[] = [];

    const result = await runRealMemoryBenchmark(retriever, (pct) => {
      progressUpdates.push(pct);
    });

    expect(result.totalQuestions).toBe(262);
    expect(result.totalPassed).toBeGreaterThanOrEqual(200);
    expect(result.overallAccuracy).toBeGreaterThanOrEqual(75.0);
    expect(result.averageLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.categories.length).toBe(9);
    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(progressUpdates[progressUpdates.length - 1]).toBe(100);
  }, 15000);
});
