import { useLayoutEffect, useState } from 'react';

import { useElementSize } from './use-element-size';

// Our choice, not a WinUI value (WinUI ships no chart legend): past two rows
// the legend stops being scanned and starts pushing the plot below the fold.
const FOLDED_LEGEND_ROWS = 2;

export const LEGEND_TAG_ATTRIBUTE = 'data-legend-tag';
export const LEGEND_FOLD_ATTRIBUTE = 'data-legend-fold';

// Ranking reorders only the legend: hues and the plot's stacking order follow
// the entries as given, so switching metric moves a tag without recolouring it.
export const rankedLegend = <T extends { id: string; pinnedLast?: boolean | undefined }>(entries: readonly T[], weights: ReadonlyMap<string, number> | undefined): T[] => {
  if (weights === undefined) return entries.toSorted((left, right) => Number(left.pinnedLast === true) - Number(right.pinnedLast === true));
  const weightOf = (id: string) => {
    const weight = weights.get(id);
    if (weight === undefined) throw new RangeError(`Legend series has no weight: ${id}`);
    return weight;
  };
  return entries.toSorted((left, right) => Number(left.pinnedLast === true) - Number(right.pinnedLast === true) || weightOf(right.id) - weightOf(left.id));
};

// How many tags fit is a property of the rendered wrap, so it is measured
// rather than counted: every tag is laid out once, the ones on the first rows
// are kept, and the toggle then gives back tags until it lands on the last
// kept row itself. Each step re-renders from a layout effect, so the reader
// only ever sees the settled legend.
export const useLegendFold = <T extends { id: string }>(entries: readonly T[], container: HTMLElement | null) => {
  const { width } = useElementSize(container);
  const [expanded, setExpanded] = useState(false);
  const layoutKey = `${width}\n${entries.map(entry => entry.id).join('\n')}`;
  const [fit, setFit] = useState<{ key: string; count: number; lastRowTop: number } | null>(null);
  const measured = fit !== null && fit.key === layoutKey ? fit : null;

  useLayoutEffect(() => {
    if (container === null || width === 0) return;
    const tags = [...container.querySelectorAll<HTMLElement>(`[${LEGEND_TAG_ATTRIBUTE}]`)];
    if (measured === null) {
      const tops = tags.map(tag => tag.getBoundingClientRect().top);
      const rows = [...new Set(tops)].sort((left, right) => left - right);
      const lastRowTop = rows[Math.min(rows.length, FOLDED_LEGEND_ROWS) - 1] ?? 0;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- The count is read off the laid-out wrap and must settle before paint.
      setFit({ key: layoutKey, count: tops.filter(top => top <= lastRowTop).length, lastRowTop });
      return;
    }
    if (expanded || measured.count === entries.length || measured.count === 0) return;
    const toggle = container.querySelector<HTMLElement>(`[${LEGEND_FOLD_ATTRIBUTE}]`);
    if (toggle === null) throw new Error('A folded legend rendered without its toggle');
    if (toggle.getBoundingClientRect().top > measured.lastRowTop) setFit({ ...measured, count: measured.count - 1 });
  }, [container, entries.length, expanded, layoutKey, measured, width]);

  const collapsible = measured !== null && measured.count < entries.length;
  const shown = measured === null || expanded || !collapsible ? [...entries] : entries.slice(0, measured.count);
  const folded = collapsible ? entries.slice(measured.count) : [];
  return { collapsible, expanded, folded, shown, toggle: () => setExpanded(current => !current) };
};
