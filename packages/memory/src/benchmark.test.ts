import { describe, expect, it } from 'vitest';
import { runRealMemoryBenchmark } from './benchmark';
import { LocalLexicalMemoryRetriever } from './index';
import { FP_AMB_OFFICIAL_QUESTIONS } from './officialFpAmbData';

describe('runRealMemoryBenchmark', () => {
  it('executes the official FP-AMB suite with honest grading and reports real metrics', async () => {
    const retriever = new LocalLexicalMemoryRetriever();
    const progressUpdates: number[] = [];

    const result = await runRealMemoryBenchmark(retriever, (pct) => {
      progressUpdates.push(pct);
    });

    // 41 of the 262 official questions (35 refusal + 6 judgment) require
    // semantic/agent-in-the-loop grading and must be excluded, not auto-passed.
    expect(result.ungradedQuestions).toBe(41);
    expect(result.totalQuestions).toBe(FP_AMB_OFFICIAL_QUESTIONS.length - 41);
    expect(result.totalQuestions).toBe(221);

    // Real corpus metrics measured from the indexed records.
    expect(result.sessionsIngested).toBe(60);
    expect(result.turnsIngested).toBe(739);
    expect(result.totalTokensIndexed).toBeGreaterThan(0);
    expect(result.ingestionSpeedMs).toBeGreaterThan(0);
    expect(result.averageLatencyMs).toBeGreaterThanOrEqual(0);

    expect(result.categories.length).toBe(9);
    const gradeableTotal = result.categories.reduce((s, c) => s + c.total, 0);
    const ungradedTotal = result.categories.reduce((s, c) => s + c.ungraded, 0);
    expect(gradeableTotal + ungradedTotal).toBe(FP_AMB_OFFICIAL_QUESTIONS.length);
    expect(gradeableTotal).toBe(result.totalQuestions);

    // Refusal category has no automated grading without an answer function.
    const refusalCat = result.categories.find((c) => c.name.includes('Unanswerable'));
    expect(refusalCat?.ungraded).toBe(35);
    expect(refusalCat?.total).toBe(0);
    expect(result.gradingNotes.length).toBeGreaterThan(0);

    expect(result.overallAccuracy).toBeGreaterThan(0);
    expect(result.totalPassed).toBeGreaterThan(0);
    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(progressUpdates[progressUpdates.length - 1]).toBe(100);
  }, 15000);
});
