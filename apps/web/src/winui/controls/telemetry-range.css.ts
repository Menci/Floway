export const telemetryRangeCss = `
/* Reserve both rows so ordinary range changes keep the control row's height. */
.floway-telemetry-range { display: grid; justify-items: end; grid-template-rows: 24px 34px; height: 58px; width: max-content; max-width: 100%; min-width: 0; flex: none; }
.floway-telemetry-range[data-reset-cycles] { grid-template: 24px auto / minmax(0, 1fr); height: auto; flex: 0 1 auto; }
.floway-telemetry-range[data-reset-cycles] > [role="radiogroup"] { flex-wrap: wrap; justify-content: flex-end; }
.floway-telemetry-range-caption { height: 20px; max-width: 100%; min-width: 0; font-size: 12px; line-height: 20px; text-align: end; white-space: nowrap; }
.floway-telemetry-range-caption-button { display: block; max-width: 100%; padding: 0; border: 0; background: transparent; color: var(--winui-text-fill-secondary); font: inherit; white-space: nowrap; cursor: pointer; }
/* The cycle flyout uses the same width as the dashboard's confirmation flyouts. */
.floway-reset-cycle-surface { display: flex; flex-direction: column; width: min(320px, calc(100vw - 32px)); }
/* ComboBox's focus rectangle sits farther out than SelectorBar's stroke.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L570 */
.floway-reset-cycle-scroller { margin: calc(-1 * var(--winui-focus-visual-outset)); min-height: 0; }
.floway-reset-cycle-scroll-content { padding: var(--winui-focus-visual-outset); }
`;
