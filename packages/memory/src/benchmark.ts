import type { MemoryRecord, MemoryRetriever } from './index';
import { LocalLexicalMemoryRetriever } from './index';
import {
  FP_AMB_OFFICIAL_CORPUS,
  FP_AMB_OFFICIAL_QUESTIONS,
  type FpAmbQuestion,
} from './officialFpAmbData';

export interface BenchmarkCategoryResult {
  name: string;
  icon: string;
  desc: string;
  passed: number;
  /** Questions that were automatically gradeable in this category. */
  total: number;
  scorePct: number;
  /** Questions excluded from automated scoring (semantic grading required). */
  ungraded: number;
}

export interface BenchmarkRunResult {
  overallAccuracy: number;
  totalPassed: number;
  /** Gradeable questions actually scored. */
  totalQuestions: number;
  /** Questions excluded from automated scoring (judgment/refusal categories). */
  ungradedQuestions: number;
  gradingNotes: string[];
  averageLatencyMs: number;
  ingestionSpeedMs: number;
  /** Whitespace-token count measured over the actually indexed records. */
  totalTokensIndexed: number;
  sessionsIngested: number;
  turnsIngested: number;
  categories: BenchmarkCategoryResult[];
  completedAt: string;
}

export interface BenchmarkOptions {
  /**
   * Optional agent-in-the-loop answer function. When provided, refusal
   * (unanswerable) questions are answered semantically and graded against the
   * official refusal answer key. Without it those questions are excluded from
   * scoring because retrieval-only grading cannot verify a refusal.
   */
  answerQuestion?: (question: string, retrievedContext: string) => Promise<string>;
}

const CATEGORY_META: Record<string, { icon: string; desc: string }> = {
  'Single-Hop Fact Recall': {
    icon: '🔍',
    desc: 'Direct retrieval of specific granular details, names, configurations, and specs.',
  },
  'Cross-Session Multi-Hop Reasoning': {
    icon: '🧠',
    desc: 'Connecting disparate clues scattered across multiple sessions separated by weeks.',
  },
  'Temporal Reasoning & Session Math': {
    icon: '⏱️',
    desc: 'Date math, timeline deltas, chronological orderings, and session sequence distances.',
  },
  'Adaptability & Fact Correction Overwrites': {
    icon: '🔄',
    desc: 'Correctly superseding outdated facts when users state newer corrections over time.',
  },
  'Self-Referential & Procedural Tool Memory': {
    icon: '🔧',
    desc: 'Recalling past tool executions, developer stack decisions, and procedural workflows.',
  },
  'Adversarial Defense & Gaslighting Robustness': {
    icon: '🕵️',
    desc: 'Resisting false leading questions and contradictory user claims across long contexts.',
  },
  'Speaker Attribution Traps': {
    icon: '🛡️',
    desc: 'Disambiguating distinct speakers across 60 multi-turn sessions without attribution drift.',
  },
  'Unanswerable & Absent Memory Refusal': {
    icon: '🚫',
    desc: 'Strict refusal to hallucinate distractor facts when memories do not exist in the corpus.',
  },
  'Source Credibility & Conflict Resolution': {
    icon: '⚖️',
    desc: 'Resolving contradictory claims by prioritizing verified sources over hearsay.',
  },
};

const UNANSWERABLE_CATEGORY = 'Unanswerable & Absent Memory Refusal';

/** Lowercase, strip punctuation, and collapse whitespace so matching is token-based. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Space-padded haystack so `containsToken` only matches on token boundaries. */
function paddedNormalized(text: string): string {
  return ` ${normalize(text)} `;
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = normalize(phrase);
  if (!needle) return false;
  return haystack.includes(` ${needle} `);
}

function isUnanswerable(q: FpAmbQuestion): boolean {
  return (
    q.category === UNANSWERABLE_CATEGORY ||
    q.grading_mode === 'refusal' ||
    /not mentioned|unknown/i.test(q.ground_truth_answer)
  );
}

/**
 * Grade one question against the retrieved records. Grading always uses the
 * raw per-turn content (never the retrieval sliding-window expansion), so an
 * accepted answer can only match a record it actually appears in.
 */
export function gradeOfficialQuestion(
  q: FpAmbQuestion,
  rawContext: string,
): { score: 0 | 1; excluded: boolean } {
  const normalizedRawContext = paddedNormalized(rawContext);

  // "judgment" mode is graded semantically by the official benchmark (LLM
  // judge). A keyword match would be a fabricated score, so exclude.
  if (q.grading_mode === 'judgment') {
    return { score: 0, excluded: true };
  }

  // List mode: every list_items group (a set of alternative phrasings for one
  // required item) must be matched for the question to pass.
  if (q.grading_mode === 'list' && q.list_items && q.list_items.length > 0) {
    const allMatched = q.list_items.every((group) =>
      group.some((alt) => containsPhrase(normalizedRawContext, alt)),
    );
    return { score: allMatched ? 1 : 0, excluded: false };
  }

  // Refusal questions need an agent answer, not retrieval, to verify.
  if (isUnanswerable(q)) {
    return { score: 0, excluded: true };
  }

  const acceptedList =
    q.accepted_answers && q.accepted_answers.length > 0
      ? q.accepted_answers
      : [q.ground_truth_answer];

  const hasMatch = acceptedList.some((ans) => {
    if (!ans) return false;
    return containsPhrase(normalizedRawContext, ans);
  });
  return { score: hasMatch ? 1 : 0, excluded: false };
}

export interface BenchmarkCorpus {
  /** Sliding-window expanded records, used for retrieval. */
  records: MemoryRecord[];
  /** Raw per-turn content by record id, used for grading. */
  rawContentById: Map<string, string>;
  sessionsIngested: number;
  turnsIngested: number;
  totalTokensIndexed: number;
}

/**
 * Builds the retrieval corpus (sliding-window expanded) plus the raw-content
 * map used for grading. Exported so retrieval variants can be measured against
 * the official grader without duplicating corpus construction.
 */
export function buildBenchmarkCorpus(): BenchmarkCorpus {
  const rawRecords = FP_AMB_OFFICIAL_CORPUS.map((turn, i) => {
    const text = turn.text || turn.content || '';
    const speaker = turn.speaker || 'User';
    const isAgent = speaker === 'Assistant' || speaker === 'Agent';
    const provenance: MemoryRecord['provenance'] = isAgent
      ? {
          source: 'agent',
          actorId: speaker.toLowerCase(),
          actorName: speaker,
          capturedAt: turn.timestamp || new Date().toISOString(),
          turnId: `t-${i}`,
          toolCallId: `tc-${i}`,
        }
      : {
          source: 'user',
          actorId: speaker.toLowerCase(),
          actorName: speaker,
          capturedAt: turn.timestamp || new Date().toISOString(),
        };
    return {
      id: `fp-amb-turn-${turn.session_id || 's'}-${turn.turn_id || i}`,
      sessionId: turn.session_id || 's',
      turnId: turn.turn_id || i,
      speaker,
      content: `${speaker}: ${text}`,
      createdAt: turn.timestamp || new Date().toISOString(),
      updatedAt: turn.timestamp || new Date().toISOString(),
      provenance,
    };
  });

  // Conversation sliding window: neighbors are copied in so lexical retrieval
  // can see dialogue cues. These expanded records are used for retrieval only —
  // grading uses the raw per-turn content.
  const records: MemoryRecord[] = rawRecords.map((r, i) => {
    const prev = i > 0 && rawRecords[i - 1].sessionId === r.sessionId ? rawRecords[i - 1].content : '';
    const next = i < rawRecords.length - 1 && rawRecords[i + 1].sessionId === r.sessionId ? rawRecords[i + 1].content : '';
    const expandedContent = [prev, r.content, next].filter(Boolean).join('\n');
    return {
      id: r.id,
      content: expandedContent,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      provenance: r.provenance,
    };
  });

  const rawContentById = new Map(rawRecords.map((r) => [r.id, r.content]));
  const sessionsIngested = new Set(rawRecords.map((r) => r.sessionId)).size;
  const turnsIngested = records.length;
  const totalTokensIndexed = records.reduce(
    (sum, r) => sum + r.content.split(/\s+/).filter(Boolean).length,
    0,
  );
  return { records, rawContentById, sessionsIngested, turnsIngested, totalTokensIndexed };
}

const REFUSAL_KEY_PHRASES = [
  'unknown',
  'not mentioned',
  'not discussed',
  'no information',
  'never mentioned',
  'do not know',
  "don't know",
  'no record',
  'cannot find',
  'not in the memory',
];

export async function runRealMemoryBenchmark(
  retriever: MemoryRetriever = new LocalLexicalMemoryRetriever(),
  onProgress?: (progressPct: number, currentCategory: string, partial?: Partial<BenchmarkRunResult>) => void,
  options: BenchmarkOptions = {},
): Promise<BenchmarkRunResult> {
  const tIngestStart = performance.now();
  const { records, rawContentById, sessionsIngested, turnsIngested, totalTokensIndexed } =
    buildBenchmarkCorpus();
  const ingestionSpeedMs = Math.max(1, performance.now() - tIngestStart);

  onProgress?.(
    5,
    `Ingested ${sessionsIngested} sessions (${turnsIngested} turns, ${totalTokensIndexed} tokens)...`,
  );

  const categoryGroups = new Map<string, FpAmbQuestion[]>();
  for (const q of FP_AMB_OFFICIAL_QUESTIONS) {
    const list = categoryGroups.get(q.category) ?? [];
    list.push(q);
    categoryGroups.set(q.category, list);
  }

  const categoryResults: BenchmarkCategoryResult[] = [];
  const gradingNotes: string[] = [];
  let totalPassed = 0;
  let totalTestsRun = 0;
  let totalUngraded = 0;
  let totalQueryTimeMs = 0;
  const totalQuestions = FP_AMB_OFFICIAL_QUESTIONS.length;

  let processedCount = 0;

  for (const [catName, questions] of categoryGroups.entries()) {
    let catPassed = 0;
    let catGradeable = 0;
    let catUngraded = 0;

    for (const q of questions) {
      const qStart = performance.now();
      const results = await retriever.retrieve(records, { query: q.question, limit: 5 });
      const qTime = performance.now() - qStart;
      totalQueryTimeMs += qTime;

      const rawContext = results
        .map((r) => rawContentById.get(r.id) ?? r.content)
        .join('\n');

      if (catName === UNANSWERABLE_CATEGORY && options.answerQuestion) {
        // Real agent-in-the-loop grading: answer the question from retrieved
        // context and check the answer against the official refusal key.
        const answer = await options.answerQuestion(q.question, rawContext);
        const refusal = REFUSAL_KEY_PHRASES.some((phrase) =>
          containsPhrase(paddedNormalized(answer), phrase),
        );
        const assertsFact = !refusal;
        catPassed += assertsFact ? 0 : 1;
        totalPassed += assertsFact ? 0 : 1;
        catGradeable++;
        totalTestsRun++;
      } else {
        const { score, excluded } = gradeOfficialQuestion(q, rawContext);
        if (excluded) {
          catUngraded++;
          totalUngraded++;
        } else {
          catPassed += score;
          totalPassed += score;
          catGradeable++;
          totalTestsRun++;
        }
      }
      processedCount++;

      if (processedCount % 10 === 0 || processedCount === totalQuestions) {
        const pct = Math.min(98, Math.round((processedCount / totalQuestions) * 100));
        onProgress?.(pct, `Evaluating Category: ${catName} (${processedCount}/${totalQuestions})...`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    const meta = CATEGORY_META[catName] ?? { icon: '🧠', desc: catName };
    if (catUngraded > 0 && catGradeable === 0) {
      gradingNotes.push(
        `${catName}: all ${catUngraded} questions require semantic/agent-in-the-loop grading and are excluded from the automated score.`,
      );
    } else if (catUngraded > 0) {
      gradingNotes.push(
        `${catName}: ${catUngraded} of ${catUngraded + catGradeable} questions excluded (semantic grading required).`,
      );
    }
    categoryResults.push({
      name: catName,
      icon: meta.icon,
      desc: meta.desc,
      passed: catPassed,
      total: catGradeable,
      scorePct: catGradeable > 0 ? Math.round((catPassed / catGradeable) * 1000) / 10 : 0,
      ungraded: catUngraded,
    });
  }

  const overallAccuracy = totalTestsRun > 0 ? Math.round((totalPassed / totalTestsRun) * 1000) / 10 : 0;
  const averageLatencyMs = totalTestsRun > 0 ? Math.round((totalQueryTimeMs / totalTestsRun) * 100) / 100 : 0;

  const finalResult: BenchmarkRunResult = {
    overallAccuracy,
    totalPassed,
    totalQuestions: totalTestsRun,
    ungradedQuestions: totalUngraded,
    gradingNotes,
    averageLatencyMs,
    ingestionSpeedMs: Math.round(ingestionSpeedMs * 100) / 100,
    totalTokensIndexed,
    sessionsIngested,
    turnsIngested,
    categories: categoryResults,
    completedAt: new Date().toISOString(),
  };

  onProgress?.(100, 'Verification complete', finalResult);
  return finalResult;
}
