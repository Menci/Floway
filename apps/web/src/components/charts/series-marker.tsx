import { fluentComponents } from '../../fluent';

const { mergeClasses } = fluentComponents;

// The swatch that carries a series' colour in a legend tag and in a callout
// row. Its shape is named for the plot form it is taken from — a square for an
// area, a circle for a line point — and each surface picks one: the legend
// tags carry the circle, the callout rows the square, which also tells a
// reader which of the two a colour is being read from. At 10px a 2px radius
// still leaves most of each edge straight, so the square keeps reading as a
// square beside the circle.
//
// WinUI ships no chart control at all, so it states neither a legend nor a
// callout swatch and there is nothing to transcribe; the 10px is our choice.
// Fluent's own chart swatch is 12px — a 12-unit path inside a 14px SVG for the
// shape legend, a 12px bordered rect for the flat one — which we find heavy
// beside the 11-12px text it stands next to, so we take 10.
// https://github.com/microsoft/microsoft-ui-xaml/tree/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/charts/react-charts/library/src/components/Legends/useLegendsStyles.styles.ts#L14-L19
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/charts/react-charts/library/src/components/Legends/shape.tsx#L39-L48
//
// The colour repeats what the label beside it already says, so the swatch is
// hidden from assistive technology in both places.
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
