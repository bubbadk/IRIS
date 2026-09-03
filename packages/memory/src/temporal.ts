/**
 * Temporal query parsing for memory retrieval. Extracts explicit time
 * expressions from a query and turns them into a time window that can boost
 * matching records. Parsing is conservative and deterministic: anything that
 * does not clearly express a time yields no window, and a query without any
 * time expression keeps retrieval behavior completely unchanged.
 */

export interface TemporalQueryWindow {
  /** Inclusive window start in epoch milliseconds. */
  fromMs: number;
  /** Inclusive window end in epoch milliseconds. */
  toMs: number;
  /** Relative score multiplier applied to records inside the window. */
  boost: number;
}

const DAY_MS = 86_400_000;

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function monthWindow(now: Date, monthIndex: number): { fromMs: number; toMs: number } {
  // The most recent occurrence of that month at or before now (so "in October"
  // asked in December resolves to the October just passed, not next year's).
  let year = now.getFullYear();
  if (monthIndex > now.getMonth()) year -= 1;
  const from = new Date(year, monthIndex, 1);
  const to = new Date(year, monthIndex + 1, 1);
  return { fromMs: from.getTime(), toMs: to.getTime() - 1 };
}

function dayRange(now: Date, daysBack: number, spanDays = 1): { fromMs: number; toMs: number } {
  const to = startOfDay(new Date(now.getTime() + (spanDays - 1) * DAY_MS)).getTime() + DAY_MS - 1;
  const from = startOfDay(new Date(now.getTime() - daysBack * DAY_MS)).getTime();
  return { fromMs: from, toMs: to };
}

/**
 * Parses one time expression out of the query. Returns the window plus the
 * remaining matched span so callers can assert an expression was present.
 */
export function parseTemporalQuery(
  query: string,
  now: Date = new Date(),
): TemporalQueryWindow | null {
  const text = query.toLowerCase();

  const lowerNow = startOfDay(now);

  // Relative expressions, resolved against the clock. English and Danish variants are
  // checked together so queries in either language resolve to the same window.
  if (/\byesterday\b|\bi går\b|\bigår\b/.test(text)) return { ...dayRange(now, 1), boost: 1.6 };
  if (/\btoday\b|\bi dag\b|\bidag\b/.test(text)) return { ...dayRange(now, 0), boost: 1.6 };
  if (/\blast month\b|\bprevious month\b|\bsidste måned\b|\bsidste maaned\b/.test(text)) {
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth(), 1);
    return { fromMs: from.getTime(), toMs: to.getTime() - 1, boost: 1.6 };
  }
  if (/\bthis month\b|\bdenne måned\b|\bdenne maaned\b|\bden her måned\b/.test(text)) {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    return { fromMs: from.getTime(), toMs: now.getTime(), boost: 1.6 };
  }
  if (/\blast week\b|\bprevious week\b|\bpast week\b|\bi sidste uge\b|\bsidste uge\b/.test(text)) {
    return { ...dayRange(now, 7), boost: 1.6 };
  }
  if (/\bthis week\b|\bdenne uge\b|\bden her uge\b/.test(text)) {
    const weekday = (now.getDay() + 6) % 7; // Monday-based
    const from = new Date(lowerNow.getTime() - weekday * DAY_MS);
    return { fromMs: from.getTime(), toMs: now.getTime(), boost: 1.6 };
  }
  if (/\blast year\b|\bprevious year\b|\bsidste år\b|\bsidste aar\b/.test(text)) {
    const year = now.getFullYear() - 1;
    return {
      fromMs: new Date(year, 0, 1).getTime(),
      toMs: new Date(year, 11, 31, 23, 59, 59, 999).getTime(),
      boost: 1.6,
    };
  }
  if (/\bthis year\b|\bdette år\b|\bdette aar\b|\bi år\b|\biaar\b/.test(text)) {
    return {
      fromMs: new Date(now.getFullYear(), 0, 1).getTime(),
      toMs: now.getTime(),
      boost: 1.6,
    };
  }

  // "in <month> <year>" / "<month> <year>" / "in <month>"
  const monthYear = text.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/,
  );
  if (monthYear) {
    const monthIndex = MONTHS.indexOf(monthYear[1]);
    const year = Number(monthYear[2]);
    return {
      fromMs: new Date(year, monthIndex, 1).getTime(),
      toMs: new Date(year, monthIndex + 1, 1).getTime() - 1,
      boost: 1.6,
    };
  }
  const monthOnly = text.match(
    /\b(?:in|during|since|before|after|by)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/,
  );
  if (monthOnly) {
    const window = monthWindow(now, MONTHS.indexOf(monthOnly[1]));
    return { ...window, boost: 1.6 };
  }

  // Bare year ("in 2026", "since 2025").
  const yearOnly = text.match(/\b(?:in|during|since|before|after)\s+(20\d{2}|19\d{2})\b/);
  if (yearOnly) {
    const year = Number(yearOnly[1]);
    return {
      fromMs: new Date(year, 0, 1).getTime(),
      toMs: new Date(year, 11, 31, 23, 59, 59, 999).getTime(),
      boost: 1.6,
    };
  }

  return null;
}

/**
 * Score multiplier for a record given a parsed temporal query. Records whose
 * timestamp falls inside the window receive the boost; everything else is
 * untouched (multiplier 1). Records without a parseable timestamp are never
 * boosted, so noisy timestamps cannot distort ranking.
 */
export function temporalBoostFactor(
  window: TemporalQueryWindow | null,
  record: { createdAt: string },
): number {
  if (!window) return 1;
  const created = Date.parse(record.createdAt);
  if (Number.isNaN(created)) return 1;
  return created >= window.fromMs && created <= window.toMs ? window.boost : 1;
}
