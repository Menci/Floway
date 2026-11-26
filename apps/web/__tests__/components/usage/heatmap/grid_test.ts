import { describe, expect, it } from 'vitest';

import type { UsageDay, UsageHistory } from '../../../../src/components/usage/heatmap/data';
import { buildHeatmapGrid, heatmapPeriods, ordinalDate, usageRecords } from '../../../../src/components/usage/heatmap/grid';
import { telemetryDayOrdinal, type DecimalString } from '@floway-dev/protocols/browser';

const ord = telemetryDayOrdinal;
const day = (date: string, tokens: string, requests = 1): UsageDay => ({ ordinal: ord(date), date, tokens: tokens as DecimalString, requests, topModel: 'gpt-5' });
const historyOf = (...days: UsageDay[]): UsageHistory => ({ days: new Map(days.map(entry => [entry.ordinal, entry])), tokens: '0', requests: 0, models: [] });
const levelOn = (grid: ReturnType<typeof buildHeatmapGrid>, date: string) => grid.columns.flat().find(cell => cell?.date === date)?.level;

// 2026-11-23 is a Monday and 2026-11-26 a Thursday.
const MONDAY = ord('2026-11-23');
const THURSDAY = ord('2026-11-26');

describe('heatmap layout', () => {
  it('lays the last year out in Monday-first weeks that end in the current week', () => {
    const grid = buildHeatmapGrid(historyOf(), 'recent', THURSDAY);

    expect(grid.columns).toHaveLength(53);
    expect(grid.columns[0]!.map(cell => cell?.date)).toEqual(['2025-11-24', '2025-11-25', '2025-11-26', '2025-11-27', '2025-11-28', '2025-11-29', '2025-11-30']);
    const lastWeek = grid.columns.at(-1)!;
    expect(lastWeek.map(cell => cell?.date ?? null)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', null, null, null]);
    expect(grid.columns.flat().filter(cell => cell?.today).map(cell => cell!.date)).toEqual(['2026-11-26']);
  });

  it('starts a new column on the Monday that is today', () => {
    const grid = buildHeatmapGrid(historyOf(), 'recent', MONDAY);

    expect(grid.columns.at(-1)!.map(cell => cell?.date ?? null)).toEqual(['2026-11-23', null, null, null, null, null, null]);
    expect(grid.columns[0]![0]!.date).toBe(ordinalDate(MONDAY - 52 * 7));
  });

  it('labels each month at the week holding its first day and skips a cramped leading month', () => {
    const grid = buildHeatmapGrid(historyOf(), 'recent', THURSDAY);

    expect(grid.months.map(month => [ordinalDate(month.ordinal), month.column])).toEqual([
      ['2025-12-01', 1], ['2026-01-01', 5], ['2026-02-01', 9], ['2026-03-01', 13], ['2026-04-01', 18], ['2026-05-01', 22],
      ['2026-06-01', 27], ['2026-07-01', 31], ['2026-08-01', 35], ['2026-09-01', 40], ['2026-10-01', 44], ['2026-11-01', 48],
    ]);
  });

  it('pads a calendar year to whole weeks and leaves the days past today empty', () => {
    const past = buildHeatmapGrid(historyOf(), 2025, THURSDAY);
    expect(past.columns[0]!.map(cell => cell?.date ?? null)).toEqual([null, null, '2025-01-01', '2025-01-02', '2025-01-03', '2025-01-04', '2025-01-05']);
    expect(past.columns.flat().filter(cell => cell !== null)).toHaveLength(365);

    const current = buildHeatmapGrid(historyOf(), 2026, THURSDAY);
    expect(current.columns).toHaveLength(53);
    expect(current.columns.flat().filter(cell => cell !== null).at(-1)!.date).toBe('2026-11-26');
  });
});

describe('heatmap levels', () => {
  it('ranks each day among the period\'s active days', () => {
    const grid = buildHeatmapGrid(historyOf(
      day('2026-11-02', '10'), day('2026-11-03', '20'), day('2026-11-04', '30'), day('2026-11-05', '40'), day('2026-11-06', '50'),
      day('2026-11-07', '0', 3),
    ), 'recent', THURSDAY);

    expect(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map(date => levelOn(grid, date))).toEqual([1, 2, 3, 3, 4]);
    expect(levelOn(grid, '2026-11-07')).toBe(0);
    expect(levelOn(grid, '2026-11-08')).toBe(0);
  });

  it('gives equal days one level and a lone active day the darkest', () => {
    const tied = buildHeatmapGrid(historyOf(day('2026-11-02', '10'), day('2026-11-03', '10'), day('2026-11-04', '90')), 'recent', THURSDAY);
    expect(levelOn(tied, '2026-11-02')).toBe(levelOn(tied, '2026-11-03'));
    expect(levelOn(tied, '2026-11-04')).toBe(4);

    const lone = buildHeatmapGrid(historyOf(day('2026-11-02', '1')), 'recent', THURSDAY);
    expect(levelOn(lone, '2026-11-02')).toBe(4);
  });

  it('scales the levels to the shown period only', () => {
    const history = historyOf(day('2024-03-01', '1000000000'), day('2026-11-02', '10'), day('2026-11-03', '20'));
    const grid = buildHeatmapGrid(history, 'recent', THURSDAY);

    expect(levelOn(grid, '2026-11-03')).toBe(4);
    expect(grid.tokens).toBe(30);
  });
});

describe('heatmap periods', () => {
  it('offers only the last year while it shows every recorded day', () => {
    expect(heatmapPeriods(historyOf(day('2026-09-21', '5'), day('2026-11-20', '5')), THURSDAY)).toEqual(['recent']);
  });

  it('offers each year with usage, newest first, once older usage falls out of view', () => {
    const history = historyOf(day('2024-06-01', '5'), day('2025-01-03', '0'), day('2026-11-20', '5'));
    expect(heatmapPeriods(history, THURSDAY)).toEqual(['recent', 2026, 2024]);
  });
});

describe('usage records', () => {
  const history = historyOf(
    day('2026-10-01', '5'), day('2026-10-02', '5'), day('2026-10-03', '900'), day('2026-10-04', '5'), day('2026-10-05', '5'),
    day('2026-11-20', '5'), day('2026-11-21', '5'), day('2026-11-22', '5'), day('2026-11-23', '0', 2),
  );

  it('keeps a streak that ended yesterday current until today passes unused', () => {
    expect(usageRecords(history, ord('2026-11-23'))).toMatchObject({ activeDays: 8, currentStreak: 3, longestStreak: 5 });
    expect(usageRecords(history, ord('2026-11-24')).currentStreak).toBe(0);
  });

  it('extends the current streak through today', () => {
    const withToday = historyOf(...history.days.values(), day('2026-11-23', '7'));
    expect(usageRecords(withToday, ord('2026-11-23')).currentStreak).toBe(4);
  });

  it('names the first and the busiest day', () => {
    const records = usageRecords(history, ord('2026-11-23'));
    expect(records.firstDay).toBe(ord('2026-10-01'));
    expect(records.peakDay?.date).toBe('2026-10-03');
    expect(usageRecords(historyOf(), ord('2026-11-23'))).toEqual({ activeDays: 0, currentStreak: 0, longestStreak: 0, firstDay: null, peakDay: null });
  });
});
