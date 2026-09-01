import { useState } from 'react';
import {
  runRealMemoryBenchmark,
  type BenchmarkRunResult,
} from '@iris/memory';

export function MemoryBenchmarkView() {
  const [running, setRunning] = useState(false);
  const [testProgress, setTestProgress] = useState<number | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>('Ready for real-time verification. No measured result yet.');
  const [liveResult, setLiveResult] = useState<BenchmarkRunResult | null>(null);

  async function handleRunVerification() {
    setRunning(true);
    setTestProgress(0);
    setStatusMsg('Ingesting official FP-AMB corpus...');

    try {
      const result = await runRealMemoryBenchmark(undefined, (pct, status) => {
        setTestProgress(pct);
        setStatusMsg(status);
      });
      setLiveResult(result);
      const ungradedNote =
        result.ungradedQuestions > 0
          ? ` · ${result.ungradedQuestions} refusal/judgment questions excluded (semantic grading required)`
          : '';
      setStatusMsg(
        `✅ Live Verification Complete: ${result.overallAccuracy}% Accuracy (${result.totalPassed} / ${result.totalQuestions} gradeable questions passed at ${result.averageLatencyMs} ms/query)${ungradedNote}`,
      );
    } catch (err) {
      setStatusMsg(`Error running benchmark: ${String(err)}`);
    } finally {
      setRunning(false);
    }
  }

  const categories = liveResult?.categories ?? [];
  const isMeasured = liveResult !== null;
  const totalPassed = isMeasured ? liveResult.totalPassed : null;
  const totalQuestions = isMeasured ? liveResult.totalQuestions : null;
  const averageLatency = isMeasured ? `${liveResult.averageLatencyMs} ms` : '—';

  return (
    <div className="memory-benchmark-view" style={{ padding: '4px 0' }}>
      {/* Header Banner */}
      <div
        style={{
          background: 'linear-gradient(135deg, rgba(80,93,83,0.08) 0%, rgba(200,165,115,0.12) 100%)',
          borderRadius: '16px',
          padding: '20px',
          border: '1px solid var(--line)',
          marginBottom: '20px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span style={{ fontSize: '20px' }}>🏆</span>
              <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: 'var(--ink)' }}>
                First-Person Agent Memory Benchmark (FP-AMB v7.0)
              </h3>
              <span
                style={{
                  background: isMeasured ? '#0284c7' : '#94a3b8',
                  color: '#ffffff',
                  fontSize: '11px',
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: '999px',
                }}
              >
                {isMeasured ? 'LIVE MEASURED ON CPU' : 'NOT YET MEASURED'}
              </span>
            </div>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
                {isMeasured
                  ? `Live verification completed at ${new Date(liveResult.completedAt).toLocaleTimeString()} · ${liveResult.sessionsIngested} sessions · ${liveResult.turnsIngested} turns · ${liveResult.totalTokensIndexed} tokens indexed (whitespace estimate).`
                  : 'Run the official 262-question exam against the local retrieval engine. Refusal and judgment questions require semantic grading and are reported separately instead of being auto-scored.'}
              </p>
            </div>
            <button
              type="button"
              className="button button-primary"
              onClick={handleRunVerification}
              disabled={running}
              style={{ fontSize: '12px', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              {running ? 'Evaluating…' : '⚡ Run Live Verification'}
            </button>
          </div>

          {/* Live Progress Bar if testing */}
          {testProgress !== null && (
            <div style={{ marginTop: '14px', background: 'rgba(0,0,0,0.06)', borderRadius: '8px', padding: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontWeight: 600, marginBottom: '6px', color: 'var(--ink)' }}>
                <span>{statusMsg}</span>
                <span>{testProgress}%</span>
              </div>
              <div style={{ height: '6px', background: 'var(--line)', borderRadius: '4px', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${testProgress}%`,
                    background: '#10b981',
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
            </div>
          )}

          {isMeasured && liveResult.gradingNotes.length > 0 && (
            <div style={{ marginTop: '14px', fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {liveResult.gradingNotes.map((note) => (
                <div key={note}>· {note}</div>
              ))}
            </div>
          )}
        </div>

        {/* Top 4 KPI Stat Cards */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '12px',
            marginBottom: '20px',
          }}
        >
          <div style={{ background: 'var(--panel)', padding: '14px', borderRadius: '12px', border: '1px solid var(--line)' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Overall Accuracy</div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: isMeasured ? (liveResult.overallAccuracy >= 90 ? '#10b981' : '#f59e0b') : 'var(--text-muted)', marginTop: '4px' }}>
              {isMeasured ? `${liveResult.overallAccuracy.toFixed(1)}%` : '—'}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {isMeasured ? `${totalPassed} / ${totalQuestions} gradeable questions passed` : 'No measured result yet'}
            </div>
          </div>

          <div style={{ background: 'var(--panel)', padding: '14px', borderRadius: '12px', border: '1px solid var(--line)' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Measured Retrieval Latency</div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: isMeasured ? 'var(--ink)' : 'var(--text-muted)', marginTop: '4px' }}>{averageLatency}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Real local CPU query time</div>
          </div>

          <div style={{ background: 'var(--panel)', padding: '14px', borderRadius: '12px', border: '1px solid var(--line)' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Corpus Preparation</div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: isMeasured ? 'var(--ink)' : 'var(--text-muted)', marginTop: '4px' }}>
              {isMeasured ? `${liveResult.ingestionSpeedMs} ms` : '—'}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Local corpus-to-record build time</div>
          </div>

          <div style={{ background: 'var(--panel)', padding: '14px', borderRadius: '12px', border: '1px solid var(--line)' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Tokens Indexed</div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: isMeasured ? 'var(--ink)' : 'var(--text-muted)', marginTop: '4px' }}>
              {isMeasured ? liveResult.totalTokensIndexed.toLocaleString('en-US') : '—'}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Whitespace-token count over indexed records</div>
          </div>
        </div>

        {/* Category Breakdown Table / Cards */}
        <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 700, color: 'var(--ink)' }}>
          Category-by-Category Exam Breakdown
        </h4>

        {!isMeasured && (
          <div
            style={{
              background: 'var(--panel)',
              border: '1px dashed var(--line)',
              borderRadius: '12px',
              padding: '24px 16px',
              textAlign: 'center',
              fontSize: '12px',
              color: 'var(--text-muted)',
            }}
          >
            No measured result yet. Run a live verification to see the real per-category scores —
            IRIS does not display benchmark numbers that were not measured on this machine.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {categories.map((cat) => {
            const notGradeable = cat.total === 0;
            return (
            <div
              key={cat.name}
              style={{
                background: 'var(--panel)',
                border: '1px solid var(--line)',
                borderRadius: '12px',
                padding: '12px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '16px' }}>{cat.icon}</span>
                  <span style={{ fontWeight: 700, fontSize: '13px', color: 'var(--ink)' }}>{cat.name}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {notGradeable ? `${cat.ungraded} ungraded` : `${cat.passed} / ${cat.total}`}
                  </span>
                  <span
                    style={{
                      fontSize: '13px',
                      fontWeight: 800,
                      color: notGradeable ? 'var(--text-muted)' : cat.scorePct >= 90 ? '#10b981' : '#f59e0b',
                      minWidth: '50px',
                      textAlign: 'right',
                    }}
                  >
                    {notGradeable ? 'N/A' : `${cat.scorePct.toFixed(1)}%`}
                  </span>
                </div>
              </div>

              {!notGradeable && (
                <div style={{ height: '6px', background: 'var(--line)', borderRadius: '4px', overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${cat.scorePct}%`,
                      background: cat.scorePct >= 90 ? '#10b981' : '#f59e0b',
                      borderRadius: '4px',
                    }}
                  />
                </div>
              )}

              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {notGradeable
                  ? 'Requires agent-in-the-loop semantic grading; excluded from the automated score.'
                  : cat.ungraded > 0
                    ? `${cat.desc} (${cat.ungraded} judgment questions excluded from this score.)`
                    : cat.desc}
              </span>
            </div>
            );
          })}
        </div>
      </div>
  );
}
