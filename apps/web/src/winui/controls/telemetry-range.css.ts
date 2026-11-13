export const telemetryRangeCss = `
/* Reserve both rows so range changes stay below the adjacent 62px Field
   without changing the control row's height. */
.floway-telemetry-range { display: grid; justify-items: end; grid-template-rows: 24px 34px; height: 58px; width: max-content; max-width: 100%; min-width: 0; }
.floway-telemetry-range-caption { height: 20px; max-width: 100%; min-width: 0; font-size: 12px; line-height: 20px; text-align: end; white-space: nowrap; }
.floway-telemetry-range-caption-button { display: block; max-width: 100%; padding: 0; border: 0; background: transparent; color: var(--winui-text-fill-secondary); font: inherit; white-space: nowrap; cursor: pointer; }
/* SelectorBar's outer focus stroke needs paint space inside the scrollport.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L472-L473 */
.floway-telemetry-range-scroller { --floway-telemetry-focus-outset: var(--winui-focus-visual-primary-thickness); margin: calc(-1 * var(--floway-telemetry-focus-outset)); }
/* ComboBox's detached focus visual includes both its outline and offset.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L570 */
.floway-telemetry-range-scroller.floway-telemetry-range-picker-scroller { --floway-telemetry-focus-outset: var(--winui-focus-visual-outset); }
.floway-telemetry-range-scroll-content { padding: var(--floway-telemetry-focus-outset); }
`;
