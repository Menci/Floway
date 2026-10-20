import { useMemo } from 'react';

import {
  performancePercentileTailOf,
  performanceSortDirectionForKey,
  performanceValue,
  resolvePerformanceGroup,
  type PerformanceDisplayRecord,
  type PerformanceGroupBy,
  type PerformanceLabels,
  type PerformancePercentiles,
  type PerformanceTableSort,
  type PerformanceTableSortKey,
} from './overview';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { formatDuration } from '../../lib/format-duration';
import { formatCount, formatTokenRate } from '../../lib/format-number';
import { useLocale } from '../../lib/use-locale';
import { EmptyStateLine } from '../ui/empty-state';
import { ScrollArea } from '../ui/scroll-area';
import { TableTrailingCell, TableTrailingHeader } from '../ui/table-actions';
import { TableColumns } from '../ui/table-columns';
import { TruncationTooltip } from '../ui/truncation-tooltip';

const {
  Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow,
} = fluentComponents;

export function PerformanceTable({ groupBy, labels, onSortChange, percentiles, rows, sort }: {
  groupBy: PerformanceGroupBy;
  labels: PerformanceLabels;
  onSortChange: (sort: PerformanceTableSort) => void;
  percentiles: PerformancePercentiles;
  rows: PerformanceDisplayRecord[];
  sort: PerformanceTableSort;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const sortBy = (key: PerformanceTableSortKey) => onSortChange(sort.key === key
    ? { key, direction: sort.direction === 'ascending' ? 'descending' : 'ascending' }
    : { key, direction: performanceSortDirectionForKey(key) });
  const sortedRows = useMemo(() => rows.toSorted((left, right) => {
    const leftValue = performanceTableSortValue(left, sort.key, groupBy, labels, percentiles);
    const rightValue = performanceTableSortValue(right, sort.key, groupBy, labels, percentiles);
    const order = typeof leftValue === 'string' && typeof rightValue === 'string'
      ? leftValue.localeCompare(rightValue)
      : Number(leftValue) - Number(rightValue);
    return sort.direction === 'ascending' ? order : -order;
  }), [groupBy, labels, percentiles, rows, sort]);
  const sortDirection = (key: PerformanceTableSortKey) => sort.key === key ? sort.direction : undefined;
  return <section className="grid gap-2.5 min-w-0">
    <ScrollArea axes="horizontal" className="rounded-[var(--winui-overlay-corner-radius,8px)] min-w-0"><Table aria-label={t(`dashboard.performance.groupBy.${groupBy}`)} size="small" className="min-w-[570px]">
      {/* Sizing the four measure columns to their widest label leaves the rest
          to the name, the only column whose content has no bound. */}
      <TableColumns widths={[null, '112px', '88px', '112px', '160px']} />
      <TableHeader><TableRow><TableHeaderCell sortable sortDirection={sortDirection('group')} onClick={() => sortBy('group')}>{t(`dashboard.performance.filters.${groupBy}`)}</TableHeaderCell><TableTrailingHeader sortable sortDirection={sortDirection('requests')} onClick={() => sortBy('requests')} className="whitespace-nowrap">{t('dashboard.performance.tables.requests')}</TableTrailingHeader><TableTrailingHeader sortable sortDirection={sortDirection('errors')} onClick={() => sortBy('errors')} className="whitespace-nowrap">{t('dashboard.performance.tables.errors')}</TableTrailingHeader><TableTrailingHeader sortable sortDirection={sortDirection('ttft')} onClick={() => sortBy('ttft')} className="whitespace-nowrap">{t('dashboard.performance.tables.ttft', { percentile: percentiles.ttft })}</TableTrailingHeader><TableTrailingHeader sortable sortDirection={sortDirection('speed')} onClick={() => sortBy('speed')} className="whitespace-nowrap">{t('dashboard.performance.tables.speed', { tail: performancePercentileTailOf(percentiles.tokPerSec) })}</TableTrailingHeader></TableRow></TableHeader>
      <TableBody>{sortedRows.length ? sortedRows.map(row => <TableRow key={row.group}><TableCell><TruncationTooltip content={row.group} relationship="description">{measureRef => <span className="winui-focus-rect block overflow-hidden text-ellipsis whitespace-nowrap" ref={measureRef} tabIndex={0}>{resolvePerformanceGroup(row.group, groupBy, labels)}</span>}</TruncationTooltip></TableCell><TableTrailingCell>{formatCount(row.requests, locale)}</TableTrailingCell><TableTrailingCell>{formatCount(row.errors, locale)}</TableTrailingCell><TableTrailingCell>{formatPerformanceLatency(row, percentiles.ttft, locale)}</TableTrailingCell><TableTrailingCell>{formatPerformanceSpeed(row, percentiles.tokPerSec)}</TableTrailingCell></TableRow>) : <TableRow><TableCell colSpan={5}><EmptyStateLine>{t('dashboard.performance.empty')}</EmptyStateLine></TableCell></TableRow>}</TableBody>
    </Table></ScrollArea>
  </section>;
}

const formatPerformanceLatency = (row: PerformanceDisplayRecord, percentile: PerformancePercentiles['ttft'], locale: string): string =>
  formatDuration(performanceValue(row, 'ttft', percentile), locale);

const formatPerformanceSpeed = (row: PerformanceDisplayRecord, percentile: PerformancePercentiles['tokPerSec']): string =>
  formatTokenRate(performanceValue(row, 'tokPerSec', percentile));

const performanceTableSortValue = (
  row: PerformanceDisplayRecord,
  key: PerformanceTableSortKey,
  groupBy: PerformanceGroupBy,
  labels: PerformanceLabels,
  percentiles: PerformancePercentiles,
): string | number => {
  if (key === 'group') return resolvePerformanceGroup(row.group, groupBy, labels);
  if (key === 'requests' || key === 'errors') return row[key];
  return performanceValue(row, key === 'ttft' ? 'ttft' : 'tokPerSec', percentiles[key === 'ttft' ? 'ttft' : 'tokPerSec']) ?? Number.NEGATIVE_INFINITY;
};
