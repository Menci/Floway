import { usageRecordWeight } from './plot';
import type { DisplayUsageRecord, UsageMetric } from './types';
import type { MultiselectOption } from '../ui/multiselect-combobox';
import type { UsageModelGroup } from '@floway-dev/protocols/browser';

// Model ids come from request traffic and may be any string, so the Other
// series takes an id no model can be sent with.
export const OTHER_SERIES_ID = '\u0000other';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `*` is the only wildcard; everything else in a pattern is literal, so a
// model id's dots and slashes need no escaping from the person typing it.
export const modelGroupPattern = (pattern: string): RegExp =>
  new RegExp(`^${pattern.trim().split('*').map(escapeRegExp).join('.*')}$`, 'iu');

/** The index of the first group whose pattern matches the model, or -1. */
export const modelGroupMatcher = (groups: readonly UsageModelGroup[]) => {
  const patterns = groups.map(group => modelGroupPattern(group.pattern));
  return (model: string): number => patterns.findIndex(pattern => pattern.test(model));
};

export interface FoldedModelSeries {
  records: DisplayUsageRecord[];
  options: MultiselectOption[];
  /** The raw models behind each series that stands for more than itself. */
  members: Map<string, string[]>;
}

// A group named like a model it does not match still joins that model's
// series: naming a group `gpt-6` is how `codex/gpt-6` and `gpt-6` become one.
export const foldModelSeries = ({ records, models, groups, otherShare, metric, otherLabel }: {
  records: readonly DisplayUsageRecord[];
  models: readonly string[];
  groups: readonly UsageModelGroup[];
  otherShare: number;
  metric: UsageMetric;
  otherLabel: (count: number) => string;
}): FoldedModelSeries => {
  const match = modelGroupMatcher(groups);
  const present = new Set(records.map(record => record.group));
  const seriesOf = new Map<string, string>();
  const membersOf = new Map<string, string[]>();
  for (const model of models) {
    const index = match(model);
    const series = index === -1 ? model : groups[index]!.name.trim();
    seriesOf.set(model, series);
    if (present.has(model)) membersOf.set(series, [...membersOf.get(series) ?? [], model]);
  }

  const grouped = records.map(record => {
    const series = seriesOf.get(record.group);
    if (series === undefined) throw new TypeError(`Usage record model is missing from the dimension values: ${record.group}`);
    return { ...record, group: series };
  });

  const folded = otherShare > 0 ? minorSeries(grouped, metric, otherShare) : new Set<string>();
  const otherMembers = [...membersOf].flatMap(([series, members]) => folded.has(series) ? members : []);
  const order = [...membersOf.keys()].filter(series => !folded.has(series));

  const members = new Map([...membersOf].filter(([series, list]) => !folded.has(series) && (list.length > 1 || list[0] !== series)));
  const options = order.map(series => ({ value: series, label: series }));
  if (otherMembers.length > 0) {
    members.set(OTHER_SERIES_ID, otherMembers);
    options.push({ value: OTHER_SERIES_ID, label: otherLabel(otherMembers.length) });
  }
  return {
    records: folded.size === 0 ? grouped : grouped.map(record => folded.has(record.group) ? { ...record, group: OTHER_SERIES_ID } : record),
    options,
    members,
  };
};

// Folding a single series would only rename it, so Other forms only when at
// least two series fall below the share.
const minorSeries = (records: readonly DisplayUsageRecord[], metric: UsageMetric, sharePercent: number): Set<string> => {
  const weights = new Map<string, number>();
  for (const record of records) weights.set(record.group, (weights.get(record.group) ?? 0) + usageRecordWeight(record, metric));
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return new Set();
  const minor = [...weights].filter(([, weight]) => (weight / total) * 100 < sharePercent).map(([series]) => series);
  return new Set(minor.length > 1 ? minor : []);
};
