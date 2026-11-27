import { hueForSeriesSlot, OTHER_SERIES_COLOR } from './palette';
import type { SeriesLegendEntry } from './series-legends';

// Caps folded charts at 9 individual series plus neutral Other so a folded
// plot fits within one `SERIES_HUES` pass on the baseline ranking.
const TOP_SERIES_LIMIT = 9;
const MIN_OTHER_SHARE_PERCENT = 1;

// Plot-internal id for the aggregated Other series. Never stored in `hidden` or
// written to the URL; visibility state lives on individual member ids.
export const OTHER_SERIES_ID = '\u0000other';

const stripModelPrefix = (model: string): string => {
  const slash = model.lastIndexOf('/');
  const tail = slash >= 0 ? model.slice(slash + 1) : model;
  return tail === '' ? model : tail;
};

type OtherSeriesMember = Pick<SeriesLegendEntry, 'id' | 'label' | 'members'>;

export interface ChartSectionOther {
  color: string;
  members: readonly OtherSeriesMember[];
}

export const otherSeriesGroup = (items: readonly OtherSeriesMember[]): ChartSectionOther | undefined =>
  items.length > 0
    ? {
        color: OTHER_SERIES_COLOR,
        members: items.map(({ id, label, members }) => ({ id, label, members })),
      }
    : undefined;

interface GroupedModelEntry {
  id: string;
  label: string;
  /** Present only when multiple raw variants merged or a prefix was stripped. */
  members: string[] | undefined;
}

interface ModelGroupingResult {
  keyOf: Map<string, string>;
  groups: GroupedModelEntry[];
}

// Takes each group's display casing from its heaviest raw variant (preferring
// an unprefixed name on ties) so a low-volume variant cannot dictate the label.
export const groupModelNames = (
  rawModels: readonly string[],
  rawWeights: ReadonlyMap<string, number>,
): ModelGroupingResult => {
  const keyOf = new Map<string, string>();
  const rawByGroup = new Map<string, Set<string>>();

  for (const model of rawModels) {
    const key = stripModelPrefix(model).toLowerCase();
    keyOf.set(model, key);
    let members = rawByGroup.get(key);
    if (members === undefined) {
      members = new Set();
      rawByGroup.set(key, members);
    }
    members.add(model);
  }

  const weightOf = (model: string) => rawWeights.get(model) ?? 0;
  const groups: GroupedModelEntry[] = [];

  for (const [id, rawSet] of rawByGroup) {
    const rawMembers = [...rawSet].sort((left, right) =>
      weightOf(right) - weightOf(left)
      || Number(left.includes('/')) - Number(right.includes('/'))
      || left.localeCompare(right));
    const label = stripModelPrefix(rawMembers[0]!);
    const members = rawMembers.length > 1 || rawMembers[0] !== label ? rawMembers : undefined;
    groups.push({ id, label, members });
  }

  return { keyOf, groups };
};

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
