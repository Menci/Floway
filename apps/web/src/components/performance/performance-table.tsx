import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { resolvePerformanceGroup, type PerformanceDisplayRecord, type PerformanceGroupBy, type PerformanceLabels } from './overview';
import { fluentComponents } from '../../fluent';
import { formatDuration } from '../../lib/format-duration';
import { formatCount, formatTokenRateFromTpot } from '../../lib/format-number';
import { useLocale } from '../../lib/use-locale';
import { EmptyStateLine } from '../ui/empty-state';
import { ScrollArea } from '../ui/scroll-area';

const {
  makeStyles,
  Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Tooltip,
} = fluentComponents;

const usePerformanceTableStyles = makeStyles({
  numericHeader: {
    whiteSpace: 'nowrap',
    '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end', whiteSpace: 'nowrap' },
  },
  // The truncated group name is the tooltip trigger and so a tab stop of its
  // own, while the cell around it never takes focus. Both WinUI strokes are
  // drawn inside the name's own box because the cell clips whatever leaves it.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
  groupName: {
    ':focus-visible': {
      boxShadow: 'inset 0 0 0 3px var(--winui-focus-stroke-inner)',
      outline: '2px solid var(--winui-focus-stroke-outer)',
      outlineOffset: '-2px',
    },
  },
});

export function PerformanceTable({ groupBy, labels, rows }: { groupBy: PerformanceGroupBy; labels: PerformanceLabels; rows: PerformanceDisplayRecord[] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const styles = usePerformanceTableStyles();
  const [sort, setSort] = useState<{ direction: 'ascending' | 'descending'; key: PerformanceTableSortKey }>({ direction: 'descending', key: 'requests' });
  const sortBy = (key: PerformanceTableSortKey) => setSort(current => current.key === key
    ? { key, direction: current.direction === 'ascending' ? 'descending' : 'ascending' }
    : { key, direction: key === 'group' ? 'ascending' : 'descending' });
  const sortedRows = useMemo(() => rows.toSorted((left, right) => {
    const leftValue = performanceTableSortValue(left, sort.key, groupBy, labels);
    const rightValue = performanceTableSortValue(right, sort.key, groupBy, labels);
    const order = typeof leftValue === 'string' && typeof rightValue === 'string'
      ? leftValue.localeCompare(rightValue)
      : Number(leftValue) - Number(rightValue);
    return sort.direction === 'ascending' ? order : -order;
  }), [groupBy, labels, rows, sort]);
  const sortDirection = (key: PerformanceTableSortKey) => sort.key === key ? sort.direction : undefined;
  return <section className="grid gap-2.5 min-w-0">
    <ScrollArea axes="horizontal" className="border border-fui-stroke1 rounded-lg min-w-0"><Table aria-label={t(`dashboard.performance.groupBy.${groupBy}`)} size="small" className="min-w-[570px]">
      {/* Fluent's Table lays out `fixed`, so columns split evenly unless the
          first row states a width: every column landed on the same 116px, which
          wrapped the longest header onto two lines and clipped model ids to
          `claude-opus-...`, hiding which of 4.6/4.7/4.8 a row described. Sizing
          the four measure columns to their widest label leaves the rest to the
          name, which is the only column whose content has no bound. */}
      <TableHeader><TableRow><TableHeaderCell sortable sortDirection={sortDirection('group')} onClick={() => sortBy('group')}>{t(`dashboard.performance.filters.${groupBy}`)}</TableHeaderCell><TableHeaderCell sortable sortDirection={sortDirection('requests')} onClick={() => sortBy('requests')} className={`${styles.numericHeader} text-right !w-[112px]`}>{t('dashboard.performance.tables.requests')}</TableHeaderCell><TableHeaderCell sortable sortDirection={sortDirection('errors')} onClick={() => sortBy('errors')} className={`${styles.numericHeader} text-right !w-[88px]`}>{t('dashboard.performance.tables.errors')}</TableHeaderCell><TableHeaderCell sortable sortDirection={sortDirection('ttft')} onClick={() => sortBy('ttft')} className={`${styles.numericHeader} text-right !w-[112px]`}>{t('dashboard.performance.tables.ttftP95')}</TableHeaderCell><TableHeaderCell sortable sortDirection={sortDirection('speed')} onClick={() => sortBy('speed')} className={`${styles.numericHeader} text-right !w-[160px]`}>{t('dashboard.performance.tables.speedP95')}</TableHeaderCell></TableRow></TableHeader>
      <TableBody>{sortedRows.length ? sortedRows.map(row => <TableRow key={row.group}><TableCell><Tooltip content={row.group} relationship="description"><span className={`${styles.groupName} block overflow-hidden text-ellipsis whitespace-nowrap`} tabIndex={0}>{resolvePerformanceGroup(row.group, groupBy, labels)}</span></Tooltip></TableCell><TableCell className="text-right tabular-nums">{formatCount(row.requests, locale)}</TableCell><TableCell className="text-right tabular-nums">{formatCount(row.errors, locale)}</TableCell><TableCell className="text-right tabular-nums">{formatDuration(row.ttftMsP95)}</TableCell><TableCell className="text-right tabular-nums">{formatTokenRateFromTpot(row.tpotUsP95)}</TableCell></TableRow>) : <TableRow><TableCell colSpan={5}><EmptyStateLine>{t('dashboard.performance.empty')}</EmptyStateLine></TableCell></TableRow>}</TableBody>
    </Table></ScrollArea>
  </section>;
}

type PerformanceTableSortKey = 'group' | 'requests' | 'errors' | 'ttft' | 'speed';

const performanceTableSortValue = (row: PerformanceDisplayRecord, key: PerformanceTableSortKey, groupBy: PerformanceGroupBy, labels: PerformanceLabels): string | number => {
  if (key === 'group') return resolvePerformanceGroup(row.group, groupBy, labels);
  if (key === 'requests' || key === 'errors') return row[key];
  if (key === 'ttft') return row.ttftMsP95 ?? Number.NEGATIVE_INFINITY;
  return row.tpotUsP95 !== null && row.tpotUsP95 > 0 ? 1_000_000 / row.tpotUsP95 : Number.NEGATIVE_INFINITY;
};
