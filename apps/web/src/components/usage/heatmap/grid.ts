import type { UsageDay, UsageHistory } from './data';
import { decimalStringToPlottableNumber } from '../../../lib/decimal-display';
import { telemetryDayOrdinal } from '@floway-dev/protocols/browser';

const DAY_MS = 86_400_000;
const WEEK = 7;
// Weeks open on Monday, as the overview's own week buckets do (ISO 8601).
const WEEK_START = 1;
const RECENT_WEEKS = 53;
// A month label needs about three columns before the next one starts.
const MONTH_LABEL_COLUMNS = 3;

export type HeatmapLevel = 0 | 1 | 2 | 3 | 4;
export const HEATMAP_LEVELS: readonly HeatmapLevel[] = [0, 1, 2, 3, 4];
export type HeatmapPeriod = 'recent' | number;

export interface HeatmapCell {
  ordinal: number;
  date: string;
  level: HeatmapLevel;
  day: UsageDay | null;
  today: boolean;
}

export interface HeatmapGrid {
  // One column per week, seven rows each; null pads days outside the period.
  columns: ReadonlyArray<ReadonlyArray<HeatmapCell | null>>;
  months: ReadonlyArray<{ column: number; ordinal: number }>;
  tokens: number;
}

export const ordinalDate = (ordinal: number): string => new Date(ordinal * DAY_MS).toISOString().slice(0, 10);

// 0 is Sunday, as Date#getUTCDay counts; 1970-01-01 was a Thursday.
export const ordinalWeekday = (ordinal: number): number => ((ordinal + 4) % WEEK + WEEK) % WEEK;

export const weekRow = (ordinal: number): number => (ordinalWeekday(ordinal) - WEEK_START + WEEK) % WEEK;

const tokensOf = (day: UsageDay | undefined): number => day === undefined ? 0 : decimalStringToPlottableNumber(day.tokens);

export const activeOrdinals = (history: UsageHistory): number[] =>
  [...history.days.values()].filter(day => tokensOf(day) > 0).map(day => day.ordinal).sort((left, right) => left - right);

// The period's layout span; days after today keep their place but stay empty.
export const heatmapSpan = (period: HeatmapPeriod, today: number): { start: number; end: number } => {
  if (period === 'recent') {
    const lastWeek = today - weekRow(today);
    return { start: lastWeek - (RECENT_WEEKS - 1) * WEEK, end: today };
  }
  return { start: telemetryDayOrdinal(`${period}-01-01`), end: telemetryDayOrdinal(`${period}-12-31`) };
};

// The calendar years holding usage, newest first. The year picker appears only
// when the recent view cannot show everything.
export const heatmapPeriods = (history: UsageHistory, today: number): HeatmapPeriod[] => {
  const active = activeOrdinals(history);
  const years = [...new Set(active.map(ordinal => Number(ordinalDate(ordinal).slice(0, 4))))].sort((left, right) => right - left);
  const recentStart = heatmapSpan('recent', today).start;
  return active.length > 0 && active[0]! < recentStart ? ['recent', ...years] : ['recent'];
};

// Levels rank a day among the period's active days, so the scale follows the
// operator's own range of use rather than a fixed token count.
const levelScale = (values: number[]) => {
  const sorted = values.toSorted((left, right) => left - right);
  return (tokens: number): HeatmapLevel => {
    if (tokens <= 0) return 0;
    if (sorted.length === 1) return 4;
    let rank = sorted.length - 1;
    while (rank > 0 && sorted[rank]! > tokens) rank -= 1;
    return 1 + Math.round(3 * rank / (sorted.length - 1)) as HeatmapLevel;
  };
};

export const buildHeatmapGrid = (history: UsageHistory, period: HeatmapPeriod, today: number): HeatmapGrid => {
  const { start, end } = heatmapSpan(period, today);
  const last = Math.min(end, today);
  const first = start - weekRow(start);
  const inPeriod = (ordinal: number) => ordinal >= start && ordinal <= last;
  const values: number[] = [];
  for (let ordinal = start; ordinal <= last; ordinal += 1) {
    const tokens = tokensOf(history.days.get(ordinal));
    if (tokens > 0) values.push(tokens);
  }
  const level = levelScale(values);
  const columns: Array<Array<HeatmapCell | null>> = [];
  const months: Array<{ column: number; ordinal: number }> = [];
  for (let column = 0; first + column * WEEK <= end; column += 1) {
    const cells: Array<HeatmapCell | null> = [];
    for (let row = 0; row < WEEK; row += 1) {
      const ordinal = first + column * WEEK + row;
      if (!inPeriod(ordinal)) {
        cells.push(null);
        continue;
      }
      const date = ordinalDate(ordinal);
      const day = history.days.get(ordinal) ?? null;
      if (date.endsWith('-01')) months.push({ column, ordinal });
      cells.push({ ordinal, date, level: level(tokensOf(day ?? undefined)), day, today: ordinal === today });
    }
    columns.push(cells);
  }
  if (!ordinalDate(start).endsWith('-01') && (months[0]?.column ?? Infinity) >= MONTH_LABEL_COLUMNS) {
    months.unshift({ column: 0, ordinal: start });
  }
  return { columns, months, tokens: values.reduce((sum, value) => sum + value, 0) };
};

export interface UsageRecords {
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  firstDay: number | null;
  peakDay: UsageDay | null;
}

// A streak that ended yesterday is still current until today passes unused.
export const usageRecords = (history: UsageHistory, today: number): UsageRecords => {
  const active = activeOrdinals(history);
  let longestStreak = 0;
  let run = 0;
  let previous: number | null = null;
  for (const ordinal of active) {
    run = previous !== null && ordinal === previous + 1 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = ordinal;
  }
  const activeSet = new Set(active);
  const anchor = activeSet.has(today) ? today : today - 1;
  let currentStreak = 0;
  while (activeSet.has(anchor - currentStreak)) currentStreak += 1;
  let peakDay: UsageDay | null = null;
  for (const ordinal of active) {
    const day = history.days.get(ordinal)!;
    if (peakDay === null || tokensOf(day) > tokensOf(peakDay)) peakDay = day;
  }
  return { activeDays: active.length, currentStreak, longestStreak, firstDay: active[0] ?? null, peakDay };
};
