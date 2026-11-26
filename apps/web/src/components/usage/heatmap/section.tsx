import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

import { createUsageHistoryLoader, type UsageHistory } from './data';
import {
  buildHeatmapGrid,
  HEATMAP_LEVELS,
  heatmapPeriods,
  usageRecords,
  type HeatmapCell,
  type HeatmapLevel,
  type HeatmapPeriod,
} from './grid';
import type { GlobalError } from '../../../api/client';
import { fluentComponents } from '../../../fluent';
import { useTranslation } from '../../../i18n/translation';
import { calendarDate } from '../../../lib/calendar-date';
import { decimalStringToPlottableNumber, formatDecimalQuantity } from '../../../lib/decimal-display';
import { formatCompactCount } from '../../../lib/format-number';
import { NO_READING } from '../../../lib/no-reading';
import { useLocale } from '../../../lib/use-locale';
import { ChoiceGroup } from '../../ui/choice-group';
import { EmptyStateLine } from '../../ui/empty-state';
import { PANEL_STACK_CLASS } from '../../ui/layout';
import { Panel } from '../../ui/panel';
import { SectionHeader } from '../../ui/section-header';
import { formatCompactDecimalCount } from '../format';
import { telemetryDayOrdinal } from '@floway-dev/protocols/browser';

const { Text, Tooltip, makeStyles, mergeClasses, tokens } = fluentComponents;

const DAY_MS = 86_400_000;
const CELL_MIN_PX = 11;
const CELL_MAX_PX = 18;
const CELL_GAP_PX = 3;
// The fill sweeps across the weeks when the history arrives.
const COLUMN_STAGGER_MS = 6;

// WinUI states the accent as one base at 1.0, 0.9 and 0.8 opacity; levels 4 and
// 3 take its first and third steps, and the two below continue that ramp so a
// quiet day still reads as used against the alt fill of an unused one.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L125-L127
const LEVEL_FILL: Record<HeatmapLevel, string> = {
  0: 'var(--winui-control-alt-fill-tertiary)',
  1: 'rgba(var(--winui-accent-base-rgb), 0.35)',
  2: 'rgba(var(--winui-accent-base-rgb), 0.55)',
  3: 'var(--winui-accent-fill-tertiary)',
  4: 'var(--winui-accent-fill-default)',
};

const useStyles = makeStyles({
  scroller: {
    overflowX: 'auto',
    padding: '2px',
  },
  grid: {
    columnGap: `${CELL_GAP_PX}px`,
    display: 'grid',
    rowGap: `${CELL_GAP_PX}px`,
  },
  month: {
    color: 'var(--winui-text-fill-secondary)',
    fontSize: tokens.fontSizeBase200,
    gridRow: 1,
    lineHeight: tokens.lineHeightBase200,
    overflow: 'visible',
    whiteSpace: 'nowrap',
    width: 0,
  },
  weekday: {
    alignSelf: 'center',
    color: 'var(--winui-text-fill-secondary)',
    fontSize: tokens.fontSizeBase200,
    gridColumn: 1,
    lineHeight: 0,
    paddingInlineEnd: '6px',
    whiteSpace: 'nowrap',
  },
  cell: {
    aspectRatio: '1',
    borderRadius: tokens.borderRadiusSmall,
    forcedColorAdjust: 'none',
    outline: '1px solid transparent',
    outlineOffset: '1px',
    transitionDuration: 'var(--winui-control-normal-animation-duration)',
    transitionProperty: 'background-color',
    transitionTimingFunction: 'var(--winui-control-fast-out-slow-in-easing)',
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms', transitionDelay: '0s' },
  },
  today: {
    outlineColor: 'var(--winui-text-fill-tertiary)',
  },
  hovered: {
    outlineColor: 'var(--winui-text-fill-primary)',
  },
  swatch: {
    borderRadius: tokens.borderRadiusSmall,
    display: 'inline-block',
    forcedColorAdjust: 'none',
    height: `${CELL_MIN_PX}px`,
    width: `${CELL_MIN_PX}px`,
  },
});

const ordinalToUtcDate = (ordinal: number) => new Date(ordinal * DAY_MS);
// 1970-01-05, the first Monday after the epoch; rows count from Monday.
const FIRST_MONDAY = 4;
const WEEKDAY_LABEL_ROWS = [0, 2, 4];
const EMPTY_HISTORY: UsageHistory = { days: new Map(), tokens: '0', requests: 0, models: [] };

function RecordTile({ detail, label, value }: { detail?: string | undefined; label: string; value: string }) {
  return <div className="grid gap-1 content-start min-w-0 rounded-[var(--winui-control-corner-radius)] bg-[var(--winui-subtle-fill-secondary)] pl-3 pr-2 py-2">
    <Text size={200} weight="semibold" className="text-fui-fg2">{label}</Text>
    <Text size={500} weight="semibold" className="tabular-nums [overflow-wrap:anywhere]">{value}</Text>
    {detail !== undefined && <Text size={200} className="text-fui-fg3 [overflow-wrap:anywhere]">{detail}</Text>}
  </div>;
}

function DayDetails({ cell, formatDate }: { cell: HeatmapCell; formatDate: (ordinal: number) => string }) {
  const { t } = useTranslation();
  const { day } = cell;
  return <div className="grid gap-0.5">
    <Text weight="semibold">{formatDate(cell.ordinal)}</Text>
    {day === null || decimalStringToPlottableNumber(day.tokens) === 0
      ? <Text>{t('monitoring.usage.heatmap.day.none')}</Text>
      : <>
          <Text className="tabular-nums">{t('monitoring.usage.heatmap.day.tokens', { tokens: formatDecimalQuantity(day.tokens) })}</Text>
          <Text className="tabular-nums">{t('monitoring.usage.heatmap.day.requests', { count: day.requests })}</Text>
          {day.topModel !== null && <Text className="text-fui-fg2">{t('monitoring.usage.heatmap.day.topModel', { model: day.topModel })}</Text>}
        </>}
  </div>;
}

export function UsageHeatmapSection({ refreshedAt }: { refreshedAt: number }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const styles = useStyles();
  const [loadHistory] = useState(createUsageHistoryLoader);
  const [history, setHistory] = useState<UsageHistory | null>(null);
  const [error, setError] = useState<GlobalError | null>(null);
  const [period, setPeriod] = useState<HeatmapPeriod>('recent');
  const [hovered, setHovered] = useState<{ cell: HeatmapCell; element: HTMLElement } | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadHistory(Date.now(), controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.error) {
        setError(result.error);
        return;
      }
      setHistory(result.data);
      setError(null);
    });
    return () => controller.abort();
  }, [loadHistory, refreshedAt]);

  const today = telemetryDayOrdinal(calendarDate(new Date(refreshedAt)));
  const shown = history ?? EMPTY_HISTORY;
  const loaded = history !== null;
  const periods = useMemo(() => heatmapPeriods(shown, today), [shown, today]);
  const activePeriod = periods.includes(period) ? period : 'recent';
  const grid = useMemo(() => buildHeatmapGrid(shown, activePeriod, today), [activePeriod, shown, today]);
  const records = useMemo(() => usageRecords(shown, today), [shown, today]);

  // A narrow panel scrolls the weeks; it opens on the latest one.
  const columnCount = grid.columns.length;
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller !== null) scroller.scrollLeft = scroller.scrollWidth;
  }, [activePeriod, columnCount, loaded]);

  const formatters = useMemo(() => ({
    full: new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }),
    medium: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }),
    month: new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }),
    weekday: new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }),
    percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }),
  }), [locale]);
  const formatFullDate = (ordinal: number) => formatters.full.format(ordinalToUtcDate(ordinal));

  if (history === null && error !== null) {
    return <Panel className={`${PANEL_STACK_CLASS} min-w-0`}>
      <SectionHeader level={2} title={t('monitoring.usage.heatmap.title')} />
      <EmptyStateLine>{t('common.errors.viewUnavailable')}</EmptyStateLine>
    </Panel>;
  }

  const days = (count: number) => t('monitoring.usage.heatmap.records.days', { count });
  const topModel = shown.models[0];
  const totalTokens = decimalStringToPlottableNumber(shown.tokens);
  const tokensText = formatCompactCount(grid.tokens, locale);

  const onPointerOver = (event: PointerEvent<HTMLDivElement>) => {
    const element = (event.target as Element).closest<HTMLElement>('[data-ordinal]');
    if (element === null) return;
    const ordinal = Number(element.dataset.ordinal);
    if (hovered?.cell.ordinal === ordinal) return;
    const cell = grid.columns.flat().find(candidate => candidate?.ordinal === ordinal);
    if (cell) setHovered({ cell, element });
  };

  return <Panel className={`${PANEL_STACK_CLASS} min-w-0`}>
    <SectionHeader
      level={2}
      title={t('monitoring.usage.heatmap.title')}
      description={t('monitoring.usage.heatmap.description')}
      actions={periods.length > 1 ? <ChoiceGroup
        ariaLabel={t('monitoring.usage.heatmap.periods.label')}
        items={periods.map(value => ({ value: String(value), label: value === 'recent' ? t('monitoring.usage.heatmap.periods.recent') : String(value) }))}
        onChange={value => setPeriod(value === 'recent' ? 'recent' : Number(value))}
        value={String(activePeriod)}
      /> : undefined}
    />

    <div className="grid gap-2 grid-cols-6 max-[1100px]:grid-cols-3 max-[520px]:grid-cols-2">
      <RecordTile
        label={t('monitoring.usage.heatmap.records.total')}
        value={loaded ? formatCompactDecimalCount(shown.tokens, locale) : NO_READING}
        detail={records.firstDay === null ? undefined : t('monitoring.usage.heatmap.records.since', { date: formatters.medium.format(ordinalToUtcDate(records.firstDay)) })}
      />
      <RecordTile label={t('monitoring.usage.heatmap.records.activeDays')} value={loaded ? days(records.activeDays) : NO_READING} />
      <RecordTile label={t('monitoring.usage.heatmap.records.currentStreak')} value={loaded ? days(records.currentStreak) : NO_READING} />
      <RecordTile label={t('monitoring.usage.heatmap.records.longestStreak')} value={loaded ? days(records.longestStreak) : NO_READING} />
      <RecordTile
        label={t('monitoring.usage.heatmap.records.peakDay')}
        value={!loaded ? NO_READING : records.peakDay === null ? t('monitoring.usage.heatmap.records.none') : formatCompactDecimalCount(records.peakDay.tokens, locale)}
        detail={records.peakDay === null ? undefined : formatters.medium.format(ordinalToUtcDate(records.peakDay.ordinal))}
      />
      <RecordTile
        label={t('monitoring.usage.heatmap.records.topModel')}
        value={!loaded ? NO_READING : topModel === undefined ? t('monitoring.usage.heatmap.records.none') : topModel.model}
        detail={topModel === undefined || totalTokens === 0 ? undefined : t('monitoring.usage.heatmap.records.share', {
          share: formatters.percent.format(decimalStringToPlottableNumber(topModel.tokens) / totalTokens),
        })}
      />
    </div>

    <div className="grid gap-2 min-w-0">
      <div className="flex items-center justify-between gap-3 flex-wrap min-w-0">
        <Text weight="semibold" className="tabular-nums">{!loaded ? NO_READING : activePeriod === 'recent'
          ? t('monitoring.usage.heatmap.summary.recent', { tokens: tokensText })
          : t('monitoring.usage.heatmap.summary.year', { tokens: tokensText, year: String(activePeriod) })}</Text>
        <div aria-hidden className="flex items-center gap-[3px]">
          <Text size={200} className="text-fui-fg2 mr-1">{t('monitoring.usage.heatmap.legend.less')}</Text>
          {HEATMAP_LEVELS.map(level => <span className={styles.swatch} key={level} style={{ backgroundColor: LEVEL_FILL[level] }} />)}
          <Text size={200} className="text-fui-fg2 ml-1">{t('monitoring.usage.heatmap.legend.more')}</Text>
        </div>
      </div>

      <div className={styles.scroller} ref={scrollerRef}>
        <Tooltip
          content={hovered === null ? '' : <DayDetails cell={hovered.cell} formatDate={formatFullDate} />}
          positioning={{ target: hovered?.element ?? null, position: 'above' }}
          relationship="description"
          visible={hovered !== null}
        >
          <div
            aria-label={t('monitoring.usage.heatmap.title')}
            className={styles.grid}
            onPointerLeave={() => setHovered(null)}
            onPointerOver={onPointerOver}
            role="group"
            style={{
              gridTemplateColumns: `auto repeat(${columnCount}, minmax(${CELL_MIN_PX}px, 1fr))`,
              gridTemplateRows: 'auto repeat(7, auto)',
              maxWidth: `calc(3em + ${columnCount * (CELL_MAX_PX + CELL_GAP_PX)}px)`,
              minWidth: `calc(3em + ${columnCount * (CELL_MIN_PX + CELL_GAP_PX)}px)`,
            }}
          >
            {grid.months.map(({ column, ordinal }) => <span className={styles.month} key={`month-${ordinal}`} style={{ gridColumn: column + 2 }}>
              {formatters.month.format(ordinalToUtcDate(ordinal))}
            </span>)}
            {WEEKDAY_LABEL_ROWS.map(row => <span className={styles.weekday} key={`weekday-${row}`} style={{ gridRow: row + 2 }}>
              {formatters.weekday.format(ordinalToUtcDate(FIRST_MONDAY + row))}
            </span>)}
            {grid.columns.flatMap((cells, column) => cells.map((cell, row) => cell === null ? null : <span
              aria-label={`${formatFullDate(cell.ordinal)}: ${cell.day === null ? t('monitoring.usage.heatmap.day.none') : t('monitoring.usage.heatmap.day.tokens', { tokens: formatDecimalQuantity(cell.day.tokens) })}`}
              className={mergeClasses(styles.cell, cell.today && styles.today, hovered?.cell.ordinal === cell.ordinal && styles.hovered)}
              data-level={cell.level}
              data-ordinal={cell.ordinal}
              key={cell.ordinal}
              role="img"
              style={{
                backgroundColor: LEVEL_FILL[cell.level],
                gridColumn: column + 2,
                gridRow: row + 2,
                transitionDelay: `${column * COLUMN_STAGGER_MS}ms`,
              } satisfies CSSProperties}
            />))}
          </div>
        </Tooltip>
      </div>
    </div>
  </Panel>;
}
