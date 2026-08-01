import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

// The line a chart shows in place of a plot when its series carry no points,
// filling and centred in the plot area it stands in for. It takes the same
// secondary foreground and body size every other empty state takes: this is
// what the region holds, not something subordinate to a sibling that is
// present.
//
// The step is WinUI's TextFillColorSecondaryBrush, stated per theme -- #9E000000
// on Light, #C5FFFFFF on the Default (dark) dictionary -- and reached through
// Fluent's colorNeutralForeground2, which ../../winui/theme.ts re-points at it,
// so both schemes follow from the one declaration. The size is Body, 14.
//
// The placeholder is static text with no state to paint beyond rest. Under
// forced colors the browser paints it CanvasText, collapsing the secondary step
// onto the primary one -- the same collapse WinUI's HighContrast dictionary
// makes by aliasing both text fills to SystemColorWindowTextColor -- so no rule
// of our own is needed there.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L5-L9
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L208-L213
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L415-L419
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L4
export const useChartStateStyles = makeStyles({
  root: { alignItems: 'center', color: 'var(--colorNeutralForeground2)', display: 'grid', fontSize: 'var(--fontSizeBase300)', height: '100%', lineHeight: 'var(--lineHeightBase300)', justifyItems: 'center' },
});
