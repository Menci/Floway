import { usageRecordWeight } from './plot';
import type { DisplayUsageRecord, UsageMetric } from './types';
import type { MultiselectOption } from '../ui/multiselect-combobox';

// Model ids come from request traffic and may be any string, so the Other
// series takes an id no model can be sent with.
export const OTHER_SERIES_ID = '\u0000other';

// The operator's rule: a model is named by what follows its last `/`, with
// these effort and speed tiers taken off its end, so the upstream-prefixed and
// tiered variants of one model read as that model.
const TIER_SUFFIX = /-(?:low|medium|high|xhigh|max|fast|highspeed|ultrafast)$/iu;

// The operator fixed the share rather than offering a choice: series carrying
// less than this percent of the plotted metric fold into Other.
export const OTHER_SHARE_PERCENT = 1;

/** The model a variant belongs to; a name the rule would empty stays whole. */
export const autoGroupName = (model: string): string => {
  let name = model.slice(model.lastIndexOf('/') + 1);
  for (let shorter = name.replace(TIER_SUFFIX, ''); shorter !== name && shorter !== ''; shorter = name.replace(TIER_SUFFIX, '')) name = shorter;
  return name === '' ? model : name;
};

export interface FoldedModelSeries {
  records: DisplayUsageRecord[];
  options: MultiselectOption[];
  /** The raw models behind each series that stands for more than itself. */
  members: Map<string, string[]>;
}

// Variants differing only in case are one model, so the series is keyed in
// lower case and labelled as its first variant spells it.
export const foldModelSeries = ({ records, models, autoGroup, autoFold, metric, otherLabel }: {
  records: readonly DisplayUsageRecord[];
  models: readonly string[];
  autoGroup: boolean;
  autoFold: boolean;
  metric: UsageMetric;
  otherLabel: (count: number) => string;
}): FoldedModelSeries => {
  const present = new Set(records.map(record => record.group));
  const seriesOf = new Map<string, string>();
  const labelOf = new Map<string, string>();
  const membersOf = new Map<string, string[]>();
  for (const model of models) {
    const name = autoGroup ? autoGroupName(model) : model;
    const series = autoGroup ? name.toLowerCase() : model;
    seriesOf.set(model, series);
    if (!present.has(model)) continue;
    if (!labelOf.has(series)) labelOf.set(series, name);
    membersOf.set(series, [...membersOf.get(series) ?? [], model]);
  }

  const grouped = records.map(record => {
    const series = seriesOf.get(record.group);
    if (series === undefined) throw new TypeError(`Usage record model is missing from the dimension values: ${record.group}`);
    return series === record.group ? record : { ...record, group: series };
  });

  const folded = autoFold ? minorSeries(grouped, metric) : new Set<string>();
  const otherMembers = [...membersOf].flatMap(([series, list]) => folded.has(series) ? list : []);
  const members = new Map([...membersOf].filter(([series, list]) => !folded.has(series) && (list.length > 1 || list[0] !== series)));
  const options = [...membersOf.keys()].filter(series => !folded.has(series)).map(series => ({ value: series, label: labelOf.get(series)! }));
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
const minorSeries = (records: readonly DisplayUsageRecord[], metric: UsageMetric): Set<string> => {
  const weights = new Map<string, number>();
  for (const record of records) weights.set(record.group, (weights.get(record.group) ?? 0) + usageRecordWeight(record, metric));
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return new Set();
  const minor = [...weights].filter(([, weight]) => (weight / total) * 100 < OTHER_SHARE_PERCENT).map(([series]) => series);
  return new Set(minor.length > 1 ? minor : []);
};
