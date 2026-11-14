// Every chart in the dashboard stands in a box of this height: the section
// reserves it, each chart host takes it, and the measured plot is drawn into it.
export const chartHeight = 320;

export const chartMargins = { top: 16, right: 20, bottom: 42, left: 54 } as const;

export const chartPlotWidth = (width: number, hasRightAxis = false): number => Math.max(
  0,
  width - chartMargins.left - chartMargins.right - (hasRightAxis ? chartMargins.left : 0),
);

export const chartTickCount = (plotWidth: number, maximum = 7): number => Math.max(
  2,
  Math.min(maximum, Math.floor(plotWidth / 120)),
);
