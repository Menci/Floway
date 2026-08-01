import { fluentComponents } from '../../fluent';

const { mergeClasses } = fluentComponents;

// The swatch that carries a series' colour in a legend tag and in a callout
// row. The shape follows the form the chart draws — a square for an area, a
// circle for a line — which today also tells the two surfaces apart, since the
// legend sits over the line chart and the callout over the area chart.
//
// WinUI ships no chart legend and no callout, so the 10px is ours. It is the
// callout table's number rather than the legend's 8, because a 2px radius eats
// most of an 8px square's corners and the two shapes stop reading apart —
// which is the one thing the swatch has to do. The colour repeats what the
// label beside it already says, so it is hidden from assistive technology in
// both places.
const SHAPE_CLASS = {
  area: 'rounded-[2px]',
  line: 'rounded-full',
} as const;

export function SeriesMarker({ className, color, shape }: { className?: string; color: string; shape: keyof typeof SHAPE_CLASS }) {
  return <span
    aria-hidden="true"
    className={mergeClasses('h-[10px] w-[10px] flex-shrink-0', SHAPE_CLASS[shape], className)}
    style={{ backgroundColor: color }}
  />;
}
