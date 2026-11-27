import {
  ChevronDown12Regular,
  ChevronUp12Regular,
  SelectAllOffRegular,
  SelectAllOnRegular,
  SquareMultipleRegular,
} from '@fluentui/react-icons';
import { useMemo, useState, type ReactNode } from 'react';

import { chartHeight } from './layout';
import { OTHER_SERIES_ID, type ChartSectionOther } from './series-grouping';
import { rankedLegend, seriesColor, type SeriesLegendEntry } from './series-legends';
import { SeriesMarker } from './series-marker';
import { invertedSeries, isolatedSeries, toggledSeries } from './series-selection';
import { fluentComponents } from '../../fluent';
import { Trans, useTranslation } from '../../i18n/translation';
import { EmptyStateLine } from '../ui/empty-state';
import { SectionHeader } from '../ui/section-header';

const {
  InteractionTag,
  InteractionTagPrimary,
  InteractionTagSecondary,
  Text,
  Toolbar,
  ToolbarButton,
  ToolbarDivider,
  Tooltip,
} = fluentComponents;

const LISTED_MEMBERS = 8;
const STRONG_COMPONENTS = { strong: <strong className="font-semibold" /> };

export type { ChartSectionOther };

export function SeriesIncludesText({ names }: { names: readonly string[] }) {
  const { t } = useTranslation();
  const listSeparator = t('monitoring.charts.series.listSeparator');
  return (
    <Text size={200}>
      {names.length > LISTED_MEMBERS
        ? <Trans
            components={STRONG_COMPONENTS}
            count={names.length - LISTED_MEMBERS}
            i18nKey="monitoring.charts.series.includesTruncated"
            values={{ members: names.slice(0, LISTED_MEMBERS).join(listSeparator) }}
          />
        : <Trans
            components={STRONG_COMPONENTS}
            i18nKey="monitoring.charts.series.includes"
            values={{ members: names.join(listSeparator) }}
          />}
    </Text>
  );
}

export function ChartSection({
  actions,
  children,
  controlsLabel,
  emptyText,
  entries,
  hidden,
  onHiddenChange,
  other,
  title,
  weights,
}: {
  actions?: ReactNode;
  children: ReactNode;
  controlsLabel: string;
  emptyText: string;
  entries: readonly SeriesLegendEntry[];
  hidden: Set<string>;
  onHiddenChange: (next: Set<string>) => void;
  other?: ChartSectionOther | undefined;
  title: string;
  weights?: ReadonlyMap<string, number> | undefined;
}) {
  const { t } = useTranslation();
  const [otherExpanded, setOtherExpanded] = useState(false);

  const topEntries = useMemo(
    () => (other === undefined ? entries : entries.filter(entry => entry.id !== OTHER_SERIES_ID)),
    [entries, other],
  );
  const orderedEntries = useMemo(() => rankedLegend(topEntries, weights), [topEntries, weights]);
  const otherMembers = useMemo(() => other?.members ?? [], [other]);
  const otherIds = useMemo(() => otherMembers.map(member => member.id), [otherMembers]);
  const allIds = useMemo(() => [...topEntries.map(entry => entry.id), ...otherIds], [topEntries, otherIds]);

  const otherVisibleCount = otherIds.filter(id => !hidden.has(id)).length;
  const otherAllHidden = otherVisibleCount === 0;
  const otherPartiallyHidden = otherVisibleCount > 0 && otherVisibleCount < otherIds.length;

  const isolate = (id: string) => onHiddenChange(isolatedSeries(allIds, hidden, id));

  const toggleOtherWhole = () => {
    const next = new Set(hidden);
    if (otherAllHidden) {
      for (const id of otherIds) next.delete(id);
    } else {
      for (const id of otherIds) next.add(id);
    }
    onHiddenChange(next);
  };

  const isolateOtherWhole = () => {
    const topIds = topEntries.map(entry => entry.id);
    const onlyOtherVisible = topIds.every(id => hidden.has(id)) && otherVisibleCount === otherIds.length;
    onHiddenChange(onlyOtherVisible ? new Set() : new Set(topIds));
  };

  const seriesTooltip = (members: readonly string[] | undefined) => members === undefined
    ? t('monitoring.charts.series.toggleHint')
    : (
        <span className="grid gap-1">
          <SeriesIncludesText names={members} />
          <Text size={200} className="text-fui-fg2">{t('monitoring.charts.series.toggleHint')}</Text>
        </span>
      );

  const otherTooltip = otherExpanded
    ? t('monitoring.charts.series.otherToggleHint')
    : (
        <span className="grid gap-1">
          <SeriesIncludesText names={otherMembers.map(member => member.label)} />
          <Text size={200} className="text-fui-fg2">{t('monitoring.charts.series.otherToggleHint')}</Text>
        </span>
      );

  const renderSeriesTag = (item: Pick<SeriesLegendEntry, 'id' | 'label' | 'members'>, color: string) => (
    <InteractionTag appearance="outline" key={item.id} shape="circular" size="small">
      <Tooltip content={seriesTooltip(item.members)} relationship="description">
        <InteractionTagPrimary
          className={hidden.has(item.id) ? 'line-through opacity-[0.55]' : ''}
          icon={<SeriesMarker className="mx-[4px]" color={color} />}
          // A double-click's two clicks land on this same series and cancel out, so the isolate that follows starts from the state the reader saw.
          onClick={event => { if (event.shiftKey) isolate(item.id); else onHiddenChange(toggledSeries(hidden, item.id)); }}
          onDoubleClick={() => isolate(item.id)}
        >
          {item.label}
        </InteractionTagPrimary>
      </Tooltip>
    </InteractionTag>
  );

  const hasLegendItems = orderedEntries.length > 0 || otherMembers.length > 0;

  return (
    <section className="grid gap-3 min-w-0">
      <SectionHeader level={2} title={title} actions={
        <Toolbar aria-label={controlsLabel} className="!p-0" size="small">
          <Tooltip content={t('monitoring.charts.series.all')} relationship="label">
            <ToolbarButton aria-label={t('monitoring.charts.series.all')} icon={<SelectAllOnRegular />} onClick={() => onHiddenChange(new Set())} />
          </Tooltip>
          <Tooltip content={t('monitoring.charts.series.none')} relationship="label">
            <ToolbarButton aria-label={t('monitoring.charts.series.none')} icon={<SelectAllOffRegular />} onClick={() => onHiddenChange(new Set(allIds))} />
          </Tooltip>
          <Tooltip content={t('monitoring.charts.series.invert')} relationship="label">
            <ToolbarButton aria-label={t('monitoring.charts.series.invert')} icon={<SquareMultipleRegular />} onClick={() => onHiddenChange(invertedSeries(allIds, hidden))} />
          </Tooltip>
          {actions !== undefined && <><ToolbarDivider />{actions}</>}
        </Toolbar>
      } />

      {hasLegendItems
        ? <div className="flex flex-wrap gap-1.5 min-w-0">
            {orderedEntries.map(entry => renderSeriesTag(entry, seriesColor(entry)))}

            {other !== undefined && otherMembers.length > 0 && <>
              <InteractionTag appearance="outline" shape="circular" size="small">
                <Tooltip content={otherTooltip} relationship="description">
                  <InteractionTagPrimary
                    className={otherAllHidden ? 'line-through opacity-[0.55]' : ''}
                    hasSecondaryAction
                    icon={<SeriesMarker className="mx-[4px]" color={other.color} />}
                    onClick={event => { if (event.shiftKey) isolateOtherWhole(); else toggleOtherWhole(); }}
                    onDoubleClick={isolateOtherWhole}
                  >
                    {otherPartiallyHidden
                      ? t('monitoring.charts.series.otherPartial', { visible: otherVisibleCount, count: otherMembers.length })
                      : t('monitoring.charts.series.otherCount', { count: otherMembers.length })}
                  </InteractionTagPrimary>
                </Tooltip>
                <InteractionTagSecondary
                  aria-expanded={otherExpanded}
                  aria-label={t(otherExpanded ? 'monitoring.charts.series.collapseOther' : 'monitoring.charts.series.expandOther')}
                  onClick={() => setOtherExpanded(current => !current)}
                >
                  {otherExpanded ? <ChevronUp12Regular /> : <ChevronDown12Regular />}
                </InteractionTagSecondary>
              </InteractionTag>

              {otherExpanded && otherMembers.map(member => renderSeriesTag(member, other.color))}
            </>}
          </div>
        : <EmptyStateLine>{emptyText}</EmptyStateLine>}

      <div className="min-w-0" style={{ minHeight: chartHeight }}>{children}</div>
    </section>
  );
}
