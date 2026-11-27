import { hueForSeriesSlot, OTHER_SERIES_COLOR } from './palette';
import type { SeriesLegendEntry } from './series-legends';

// Caps folded charts at 9 individual series plus neutral Other so a folded
// plot fits within one `SERIES_HUES` pass on the baseline ranking.
const TOP_SERIES_LIMIT = 9;
const MIN_OTHER_SHARE_PERCENT = 1;

// Plot-internal id for the aggregated Other series. Never stored in `hidden` or
// written to the URL; visibility state lives on individual member ids.
export const OTHER_SERIES_ID = '\u0000other';

type OtherSeriesMember = Pick<SeriesLegendEntry, 'id' | 'label'>;

export interface ChartSectionOther {
  color: string;
  members: readonly OtherSeriesMember[];
}

export const otherSeriesGroup = (items: readonly OtherSeriesMember[]): ChartSectionOther | undefined =>
  items.length > 0
    ? {
        color: OTHER_SERIES_COLOR,
        members: items.map(({ id, label }) => ({ id, label })),
      }
    : undefined;

// Assigns palette slots from a metric-independent baseline so switching metrics
// or toggling Other never recolours surviving series.
export const stableSeriesHues = (
  ids: readonly string[],
  baselineWeights: ReadonlyMap<string, number>,
  explicitHues?: ReadonlyMap<string, number>,
): Map<string, number> => {
  const ordered = [...new Set(ids)].sort((left, right) =>
    (baselineWeights.get(right) ?? 0) - (baselineWeights.get(left) ?? 0)
    || left.localeCompare(right));
  return new Map(ordered.map((id, slot) => [id, explicitHues?.get(id) ?? hueForSeriesSlot(slot)]));
};

export const partitionSeriesForOther = <T extends { id: string }>(
  items: readonly T[],
  activeWeights: ReadonlyMap<string, number>,
  foldSmall: boolean,
): { top: T[]; other: T[] } => {
  const weightOf = (id: string) => activeWeights.get(id) ?? 0;
  const ranked = items.toSorted((left, right) => weightOf(right.id) - weightOf(left.id));
  if (!foldSmall) return { top: ranked, other: [] };

  const total = ranked.reduce((sum, item) => sum + weightOf(item.id), 0);
  if (total <= 0) return { top: ranked, other: [] };

  const major: T[] = [];
  const minor: T[] = [];
  for (const item of ranked) {
    const share = (weightOf(item.id) / total) * 100;
    if (major.length < TOP_SERIES_LIMIT && share >= MIN_OTHER_SHARE_PERCENT) major.push(item);
    else minor.push(item);
  }
  // Folding a single minor series into Other would merely rename it.
  if (minor.length < 2) return { top: ranked, other: [] };
  return { top: major, other: minor };
};
