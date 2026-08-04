import { SelectAllOffRegular, SelectAllOnRegular, SquareMultipleRegular } from '@fluentui/react-icons';

import { chartHeight } from './layout';
import { colorForSlot } from './palette';
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
}: {
  children: React.ReactNode;
  controlsLabel: string;
  emptyText: string;
  entries: readonly SeriesLegendEntry[];
  hidden: Set<string>;
  onHiddenChange: (next: Set<string>) => void;
  title: string;
}) {
  const { t } = useTranslation();
  const ids = entries.map(entry => entry.id);
  const isolate = (id: string) => onHiddenChange(isolatedSeries(ids, hidden, id));

  return (
    <section className="grid gap-3 min-w-0">
      <SectionHeader level={2} title={title} actions={
        <Toolbar aria-label={controlsLabel} className="!p-0" size="small">
          <Tooltip content={t('dashboard.charts.series.all')} relationship="label">
            <ToolbarButton aria-label={t('dashboard.charts.series.all')} icon={<SelectAllOnRegular />} onClick={() => onHiddenChange(new Set())} />
          </Tooltip>
          <Tooltip content={t('dashboard.charts.series.none')} relationship="label">
            <ToolbarButton aria-label={t('dashboard.charts.series.none')} icon={<SelectAllOffRegular />} onClick={() => onHiddenChange(new Set(ids))} />
          </Tooltip>
          <Tooltip content={t('dashboard.charts.series.invert')} relationship="label">
            <ToolbarButton aria-label={t('dashboard.charts.series.invert')} icon={<SquareMultipleRegular />} onClick={() => onHiddenChange(invertedSeries(ids, hidden))} />
          </Tooltip>
        </Toolbar>
      } />

      {entries.length
        ? <div className="flex flex-wrap gap-1.5 min-w-0">
            {entries.map(entry => (
              <InteractionTag appearance="outline" key={entry.id} shape="circular" size="small">
                <Tooltip content={t('dashboard.charts.series.toggleHint')} relationship="description">
                  <InteractionTagPrimary
                    className={hidden.has(entry.id) ? 'line-through opacity-[0.55]' : ''}
                    icon={<SeriesMarker className="mx-[4px]" color={colorForSlot(entry.colorSlot)} />}
                    // A double-click's two clicks land on this same series and cancel out, so the isolate that follows starts from the state the reader saw.
                    onClick={event => { if (event.shiftKey) isolate(entry.id); else onHiddenChange(toggledSeries(hidden, entry.id)); }}
                    onDoubleClick={() => isolate(entry.id)}
                  >
                    {entry.label}
                  </InteractionTagPrimary>
                </Tooltip>
              </InteractionTag>
            ))}
          </div>
        : <EmptyStateLine>{emptyText}</EmptyStateLine>}

      <div className="min-w-0" style={{ minHeight: chartHeight }}>{children}</div>
    </section>
  );
}
