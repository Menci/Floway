import { SelectAllOffRegular, SelectAllOnRegular, SquareMultipleRegular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';

import { colorForSlot } from './palette';
import { invertedSeries, isolatedSeries, toggledSeries } from './series-selection';
import { fluentComponents } from '../../fluent';

const { InteractionTag, InteractionTagPrimary, Text, Toolbar, ToolbarButton, Tooltip } = fluentComponents;

export interface SeriesLegendEntry {
  id: string;
  label: string;
  colorSlot: number;
}

// The header controls, the legend, and the plot frame are the same in every
// chart the dashboard draws; only the plot itself differs, so it arrives as
// children.
export function ChartSection({
  children,
  controlsLabel,
  colorForEntry = colorForSlot,
  emptyText,
  entries,
  hidden,
  onHiddenChange,
  title,
}: {
  children: React.ReactNode;
  controlsLabel: string;
  colorForEntry?: (slot: number) => string;
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
      <div className="flex items-center gap-3 justify-between min-w-0 max-[900px]:flex-col max-[900px]:items-stretch">
        <Text as="h2" size={500} weight="semibold" className="m-0 text-fui-fg1">{title}</Text>
        <Toolbar aria-label={controlsLabel} className="flex-none !p-0" size="small">
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
      </div>

      {entries.length
        ? <div className="flex flex-wrap gap-[6px] min-w-0">
            {entries.map(entry => (
              <InteractionTag appearance="outline" key={entry.id} shape="circular" size="small">
                <InteractionTagPrimary
                  className={hidden.has(entry.id) ? 'line-through opacity-[0.55]' : ''}
                  icon={<span
                    aria-hidden="true"
                    className="rounded-full h-[8px] w-[8px] mx-[4px] flex-shrink-0"
                    style={{ backgroundColor: colorForEntry(entry.colorSlot) }}
                  />}
                  title={t('dashboard.charts.series.toggleHint')}
                  // A double-click delivers its two clicks first; both land on
                  // this same series and cancel out, so the isolate that follows
                  // starts from the state the reader saw.
                  onClick={event => { if (event.shiftKey) isolate(entry.id); else onHiddenChange(toggledSeries(hidden, entry.id)); }}
                  onDoubleClick={() => isolate(entry.id)}
                >
                  {entry.label}
                </InteractionTagPrimary>
              </InteractionTag>
            ))}
          </div>
        : <Text size={200} className="text-fui-fg2">{emptyText}</Text>}

      <div className="min-h-[320px] min-w-0">{children}</div>
    </section>
  );
}
