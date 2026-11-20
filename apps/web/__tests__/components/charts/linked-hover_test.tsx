import { act, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

import { LinkedChartAssumedHover, LinkedChartHoverProvider, nearestChartPoint, useLinkedChartHover, type ChartHoverPointer } from '../../../src/components/charts/linked-hover';
import { renderInApp } from '../../render';

const pointer = (xRatio: number): ChartHoverPointer => ({ xRatio, yRatio: 0.5 });

it('does not let a chart that lost the hover clear the chart that took it over', async () => {
  let first: ((pointer: ChartHoverPointer | null) => void) | undefined;
  let second: ((pointer: ChartHoverPointer | null) => void) | undefined;
  function First() {
    first = useLinkedChartHover().report;
    return null;
  }
  function Second() {
    second = useLinkedChartHover().report;
    return null;
  }
  function Target() {
    const { assumedHover } = useLinkedChartHover();
    return <LinkedChartAssumedHover hover={assumedHover} resolve={pointer => pointer.xRatio}>{ratio => String(ratio)}</LinkedChartAssumedHover>;
  }
  renderInApp(<LinkedChartHoverProvider><First /><Second /><Target /></LinkedChartHoverProvider>);
  act(() => first!(pointer(0.25)));
  act(() => second!(pointer(0.75)));
  expect(await screen.findByText('0.75')).not.toBeNull();
  act(() => first!(null));
  expect(screen.getByText('0.75')).not.toBeNull();
  act(() => second!(null));
  expect(screen.queryByText('0.75')).toBeNull();
});

it('resolves a position against the target chart\'s own points', () => {
  const hour = 3_600_000;
  // Hours 1, 5 and 9 in a ten-hour window: a source chart bucketing hourly ends
  // its 08:00-09:00 bucket at 09:00 and used to select the 09:00 sample, but a
  // pointer in the middle of that hour is nearest the 05:00 sample.
  const sparse = [1 * hour, 5 * hour, 9 * hour];
  expect(nearestChartPoint(sparse, 8.5 * hour, point => point)).toBe(9 * hour);
  expect(nearestChartPoint(sparse, 7 * hour, point => point)).toBe(5 * hour);
  expect(nearestChartPoint(sparse, 6.9 * hour, point => point)).toBe(5 * hour);
  expect(nearestChartPoint(sparse, 3 * hour, point => point)).toBe(1 * hour);
  expect(nearestChartPoint(sparse, 3.1 * hour, point => point)).toBe(5 * hour);
  // Positions past the ends stay on the end point rather than dropping the hover.
  expect(nearestChartPoint(sparse, 100 * hour, point => point)).toBe(9 * hour);
  expect(nearestChartPoint(sparse, -100 * hour, point => point)).toBe(1 * hour);
});
