import { SelectAllOffRegular, SelectAllOnRegular, SquareMultipleRegular } from '@fluentui/react-icons';
import { useMemo, useState } from 'react';

import { chartHeight } from './layout';
import { LEGEND_FOLD_ATTRIBUTE, LEGEND_TAG_ATTRIBUTE, rankedLegend, useLegendFold } from './legend-fold';
import { colorForHue } from './palette';
import type { SeriesLegendEntry } from './series-legends';
import { SeriesMarker } from './series-marker';
import { invertedSeries, isolatedSeries, toggledSeries } from './series-selection';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { EmptyStateLine } from '../ui/empty-state';
import { SectionHeader } from '../ui/section-header';

const { InteractionTag, InteractionTagPrimary, Toolbar, ToolbarButton, Tooltip } = fluentComponents;

export function ChartSection({
  children,
  controlsLabel,
  emptyText,
  entries,
  hidden,
  onHiddenChange,
  title,
  weights,
}: {
  children: React.ReactNode;
  controlsLabel: string;
  emptyText: string;
  entries: readonly SeriesLegendEntry[];
  hidden: Set<string>;
  onHiddenChange: (next: Set<string>) => void;
  title: string;
  /** How much each series carries, by id; the legend lists the heaviest first. */
  weights?: ReadonlyMap<string, number> | undefined;
}) {
  const { t } = useTranslation();
  const [legendElement, setLegendElement] = useState<HTMLDivElement | null>(null);
  const ids = entries.map(entry => entry.id);
  const legend = useLegendFold(useMemo(() => rankedLegend(entries, weights), [entries, weights]), legendElement);
  const foldedHidden = legend.folded.filter(entry => hidden.has(entry.id)).length;
  const isolate = (id: string) => onHiddenChange(isolatedSeries(ids, hidden, id));

  return (
    <section className="grid gap-3 min-w-0">
      <SectionHeader level={2} title={title} actions={
        <Toolbar aria-label={controlsLabel} className="!p-0" size="small">
          <Tooltip content={t('monitoring.charts.series.all')} relationship="label">
            <ToolbarButton aria-label={t('monitoring.charts.series.all')} icon={<SelectAllOnRegular />} onClick={() => onHiddenChange(new Set())} />
          </Tooltip>
          <Tooltip content={t('monitoring.charts.series.none')} relationship="label">
            <ToolbarButton aria-label={t('monitoring.charts.series.none')} icon={<SelectAllOffRegular />} onClick={() => onHiddenChange(new Set(ids))} />
          </Tooltip>
          <Tooltip content={t('monitoring.charts.series.invert')} relationship="label">
            <ToolbarButton aria-label={t('monitoring.charts.series.invert')} icon={<SquareMultipleRegular />} onClick={() => onHiddenChange(invertedSeries(ids, hidden))} />
          </Tooltip>
        </Toolbar>
      } />

      {entries.length
        ? <div className="flex flex-wrap gap-1.5 min-w-0" ref={setLegendElement}>
            {legend.shown.map(entry => (
              <InteractionTag appearance="outline" key={entry.id} shape="circular" size="small" {...{ [LEGEND_TAG_ATTRIBUTE]: '' }}>
                <Tooltip content={t('monitoring.charts.series.toggleHint')} relationship="description">
                  <InteractionTagPrimary
                    className={hidden.has(entry.id) ? 'line-through opacity-[0.55]' : ''}
                    icon={<SeriesMarker className="mx-[4px]" color={colorForHue(entry.hue)} />}
                    // A double-click's two clicks land on this same series and cancel out, so the isolate that follows starts from the state the reader saw.
                    onClick={event => { if (event.shiftKey) isolate(entry.id); else onHiddenChange(toggledSeries(hidden, entry.id)); }}
                    onDoubleClick={() => isolate(entry.id)}
                  >
                    {entry.label}
                  </InteractionTagPrimary>
                </Tooltip>
              </InteractionTag>
            ))}
            {legend.collapsible && <InteractionTag appearance="outline" shape="circular" size="small" {...{ [LEGEND_FOLD_ATTRIBUTE]: '' }}>
              <InteractionTagPrimary onClick={legend.toggle}>
                {legend.expanded
                  ? t('monitoring.charts.series.showFewer')
                  : foldedHidden > 0
                    ? t('monitoring.charts.series.showMoreWithHidden', { count: legend.folded.length, hidden: foldedHidden })
                    : t('monitoring.charts.series.showMore', { count: legend.folded.length })}
              </InteractionTagPrimary>
            </InteractionTag>}
          </div>
        : <EmptyStateLine>{emptyText}</EmptyStateLine>}

      <div className="min-w-0" style={{ minHeight: chartHeight }}>{children}</div>
    </section>
  );
}
