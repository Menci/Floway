import { fluentComponents } from '../../fluent';

const { mergeClasses } = fluentComponents;

// WinUI ships no chart control, so 10px is ours, taken under Fluent's own 12px
// swatch, which reads heavy beside the 11-12px text it stands next to.
// https://github.com/microsoft/microsoft-ui-xaml/tree/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/charts/react-charts/library/src/components/Legends/useLegendsStyles.styles.ts#L14-L19
export function SeriesMarker({ className, color }: { className?: string; color: string }) {
  return <span
    aria-hidden="true"
    className={mergeClasses('h-[10px] w-[10px] flex-shrink-0 rounded-full', className)}
    style={{ backgroundColor: color }}
  />;
}
