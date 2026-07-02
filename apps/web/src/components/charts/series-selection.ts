import type { ChartConfiguration } from 'chart.js/auto';

export type SeriesSelectionAction = 'all' | 'invert' | 'none';

export const chartSeriesIds = (config: ChartConfiguration<'line'>): string[] =>
  config.data.datasets.map(dataset => (dataset as unknown as { seriesId: string }).seriesId);

// Chart.js filters events reaching plugins through the `events` list. `dblclick`
// isn't in the default set, so we opt in here — otherwise `legend.onClick` never
// sees the second click of a double-click isolation gesture.
export const chartEventsWithDoubleClick: (keyof HTMLElementEventMap)[] = ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove', 'dblclick'];

export const applySeriesSelection = (hidden: Set<string>, ids: readonly string[], action: SeriesSelectionAction) => {
  if (action === 'all') {
    hidden.clear();
    return;
  }
  const nextHidden = action === 'none' ? ids : ids.filter(id => !hidden.has(id));
  hidden.clear();
  for (const id of nextHidden) hidden.add(id);
};

export const createSeriesIsolation = () => {
  let exitCandidate: string | null = null;
  return {
    toggle(hidden: Set<string>, id: string) {
      if (exitCandidate !== id) exitCandidate = null;
      if (hidden.has(id)) hidden.delete(id);
      else hidden.add(id);
    },
    isolateOrSelectAll(hidden: Set<string>, ids: readonly string[], id: string) {
      const active = ids.filter(seriesId => !hidden.has(seriesId));
      if ((active.length === 1 && active[0] === id) || exitCandidate === id) {
        hidden.clear();
        exitCandidate = null;
        return;
      }
      hidden.clear();
      for (const seriesId of ids) if (seriesId !== id) hidden.add(seriesId);
      exitCandidate = id;
    },
  };
};

type SeriesIsolation = ReturnType<typeof createSeriesIsolation>;

export const handleLegendClick = (
  event: { native?: Event | null },
  isolation: SeriesIsolation,
  hidden: Set<string>,
  ids: readonly string[],
  id: string,
) => {
  const native = event.native;
  if (native instanceof MouseEvent && (native.shiftKey || native.detail >= 2)) isolation.isolateOrSelectAll(hidden, ids, id);
  else isolation.toggle(hidden, id);
};
