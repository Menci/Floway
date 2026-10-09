export const calendarCss = `
/* DevWinUI keeps the native CalendarView measurements and brushes but centers
   its header between left/right navigation buttons.
   https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Themes/Styles/CommonStyles/CalendarViewStyle.xaml#L435-L503
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CalendarView_themeresources.xaml#L243-L321
   CalendarViewBackground uses ControlFillColorInputActiveBrush in both themes.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CalendarView_themeresources.xaml#L20
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CalendarView_themeresources.xaml#L178 */
.floway-calendar {
  --floway-calendar-day-size: 40px;
  --floway-calendar-day-margin: 1px;
  --floway-calendar-row-size: calc(var(--floway-calendar-day-size) + 2 * var(--floway-calendar-day-margin));
  --floway-calendar-grid-width: calc(7 * var(--floway-calendar-row-size));
  box-sizing: border-box;
  width: calc(var(--floway-calendar-grid-width) + 4px);
  background-color: var(--winui-control-fill-input-active);
  color: var(--winui-text-fill-primary);
  font-family: var(--fontFamilyBase);
  font-size: 14px;
  line-height: normal;
  border-radius: 4px 0 0 4px;
}
.floway-calendar button {
  font: inherit;
  color: inherit;
  cursor: pointer;
  background: transparent;
  border: 0;
}
/* Header and weekday metrics are resource constraints, with natural text
   lineboxes rather than imported Fluent line heights.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CalendarView_themeresources.xaml#L60-L81 */
.floway-calendar-header { position: relative; isolation: isolate; display: grid; grid-template-columns: auto 1fr auto; }
.floway-calendar-heading {
  margin: 6px 3px 7px 7px;
  padding: 7px 8px 8px;
  font-weight: 600 !important;
  border: 1px solid transparent !important;
  border-radius: var(--winui-control-corner-radius);
}
.floway-calendar-navigation { border: 1px solid transparent !important; display: grid; place-items: center; padding: 11.5px 12px; border-radius: var(--winui-control-corner-radius); }
.floway-calendar-navigation > span { font-size: 8px; line-height: normal; }
.floway-calendar-navigation svg { width: 8px; height: 8px; vertical-align: middle; }
.floway-calendar-previous { margin: 6px 3px 7px; }
.floway-calendar-next { margin: 6px 7px 7px 3px; }
.floway-calendar-heading:hover:enabled, .floway-calendar-navigation:hover:enabled { background-color: var(--winui-subtle-fill-secondary); }
.floway-calendar-heading:active:enabled, .floway-calendar-navigation:active:enabled { background-color: var(--winui-subtle-fill-tertiary); }
.floway-calendar-heading:active:enabled { color: var(--winui-text-fill-secondary); }
.floway-calendar-navigation:hover:enabled, .floway-calendar-navigation:active:enabled { color: var(--winui-control-strong-fill-default); }
.floway-calendar-heading:disabled, .floway-calendar-navigation:disabled { color: var(--winui-text-fill-disabled); cursor: default; }
.floway-calendar-navigation:disabled { color: var(--winui-control-strong-fill-disabled); }
/* Accent header is enabled by DateTimePicker's default Clock composition.
   https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Controls/Native/Date/CalendarWithClock/CalendarViewAttach.cs#L54-L85
   https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Themes/Styles/CommonStyles/CalendarViewStyle.xaml#L447 */
.floway-calendar[data-accent-header] .floway-calendar-header::before { content: ''; position: absolute; z-index: -1; inset: 4px 0 4px 4px; border-radius: 8px 0 0 8px; background-color: var(--winui-accent-fill-default); }
.floway-calendar[data-accent-header] .floway-calendar-heading, .floway-calendar[data-accent-header] .floway-calendar-navigation { color: var(--winui-text-on-accent-fill-primary); }
.floway-calendar[data-accent-header] .floway-calendar-heading:disabled, .floway-calendar[data-accent-header] .floway-calendar-navigation:disabled { color: var(--winui-text-on-accent-fill-disabled); }
.floway-calendar[data-accent-header] .floway-calendar-top-border { height: 0; }
.floway-calendar-top-border { height: 1px; background-color: var(--winui-control-stroke-default); }
.floway-calendar-views { position: relative; overflow: hidden; }
.floway-calendar-measure { visibility: hidden; }
.floway-calendar-month-measure { height: calc(6 * var(--floway-calendar-row-size)); margin: 2px; }
.floway-calendar-background, .floway-calendar-view { position: absolute; inset: 0; transform-origin: center; }
.floway-calendar-background { background-color: transparent; }
.floway-calendar-outgoing { pointer-events: none; }
/* WeekDayNames inherits the calendar background again; BackgroundLayer has
   no brush. With the translucent dark brush, only the weekday strip receives
   the second layer.
   https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Themes/Styles/CommonStyles/CalendarViewStyle.xaml#L458-L490 */
.floway-calendar-weekdays { display: grid; grid-template-columns: repeat(7, 1fr); margin: 2px 2px 0; background-color: var(--winui-control-fill-input-active); }
.floway-calendar-weekdays > span { box-sizing: border-box; justify-self: center; align-self: center; white-space: nowrap; text-align: center; margin: 1px; padding: 12px; font-size: 12px; font-weight: 600; line-height: normal; }
/* ScrollViewer owns month navigation, not a fade on each row. Its native
   manipulation API takes bounds and an animate flag rather than a duration.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/CalendarView_Partial.cpp#L1584-L1613 */
.floway-calendar-scroll { height: calc(6 * var(--floway-calendar-row-size)); margin: 2px; overflow-x: hidden; overflow-y: auto; scrollbar-width: none; scroll-snap-type: y proximity; }
.floway-calendar-scroll::-webkit-scrollbar { display: none; }
.floway-calendar-plane { position: relative; }
.floway-calendar-row { display: grid; position: absolute; left: 0; right: 0; scroll-snap-align: start; }
.floway-calendar-large-scroll { height: calc(100% - 4px); }
.floway-calendar-item { box-sizing: border-box; position: relative; display: grid; place-items: center; isolation: isolate; }
.floway-calendar-item > span { position: relative; margin-top: 3px; }
.floway-calendar-day { min-width: var(--floway-calendar-day-size); min-height: var(--floway-calendar-day-size); margin: var(--floway-calendar-day-margin); padding: 0 0 4px; }
/* Brush precedence is today, then selected, then out-of-scope.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CalendarView_themeresources.xaml#L5-L51
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/core/elements/CalendarViewBaseItemChrome.cpp#L1335-L1621 */
.floway-calendar-item::before { content: ''; position: absolute; z-index: -1; box-sizing: border-box; border: 1px solid transparent; border-radius: 50%; background-color: transparent; }
.floway-calendar-day::before { inset: 0; }
.floway-calendar-item[data-outside] { color: var(--winui-text-fill-secondary); }
.floway-calendar-item:hover::before { background-color: var(--winui-subtle-fill-secondary); border-color: var(--winui-subtle-fill-secondary); }
.floway-calendar-item:active::before { background-color: var(--winui-subtle-fill-tertiary); border-color: var(--winui-subtle-fill-tertiary); }
.floway-calendar-item:active { color: var(--winui-text-fill-secondary); }
.floway-calendar-item[data-outside]:hover { color: var(--winui-text-fill-primary); }
.floway-calendar-item[data-outside]:active { color: var(--winui-text-fill-tertiary); }
.floway-calendar-item[data-selected] { color: var(--winui-accent-text-fill-primary); }
.floway-calendar-item[data-selected]::before { border-color: var(--winui-accent-fill-default); }
.floway-calendar-item[data-selected]:hover::before { border-color: var(--winui-accent-fill-secondary); }
.floway-calendar-item[data-selected]:active { color: var(--winui-accent-text-fill-tertiary); }
.floway-calendar-item[data-selected]:active::before { border-color: var(--winui-subtle-fill-tertiary); }
.floway-calendar-item[data-current], .floway-calendar-item[data-current]:hover, .floway-calendar-item[data-current]:active { color: var(--winui-text-on-accent-fill-primary); }
.floway-calendar-item[data-current]::before { background-color: var(--winui-accent-fill-default); border-color: transparent; }
.floway-calendar-item[data-current]:hover::before { background-color: var(--winui-accent-fill-secondary); border-color: transparent; }
.floway-calendar-item[data-current]:active::before { background-color: var(--winui-accent-fill-tertiary); border-color: transparent; }
.floway-calendar-item[data-current][data-selected]::before { box-shadow: inset 0 0 0 1px var(--winui-text-on-accent-fill-primary); }
/* Rounded year/decade items reserve 9px on every side. They have a today
   state, but selection belongs exclusively to CalendarViewDayItem.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/CalendarViewGeneratorHost.cpp#L215-L224
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/CalendarViewGeneratorYearViewHost.cpp#L77-L89 */
.floway-calendar-large-item { margin: 9px; padding: 0; }
.floway-calendar-large-item > span { margin: 0; }
.floway-calendar-large-item::before { width: var(--floway-calendar-item-diameter); aspect-ratio: 1; }
.floway-calendar-item:disabled { color: var(--winui-text-fill-disabled); cursor: default; }
.floway-calendar-item:disabled::before { background-color: transparent; border-color: transparent; }
.floway-calendar-item[data-selected]:disabled { color: var(--winui-accent-text-fill-disabled); }
.floway-calendar-item[data-selected]:disabled::before { border-color: var(--winui-accent-fill-disabled); }
.floway-calendar-item[data-current]:disabled { color: var(--winui-text-on-accent-fill-primary); }
.floway-calendar-item[data-current]:disabled::before { background-color: var(--winui-accent-fill-disabled); border-color: var(--winui-accent-fill-disabled); }
.floway-calendar button:focus-visible { outline: 2px solid var(--winui-focus-stroke-outer); outline-offset: 1px; box-shadow: 0 0 0 1px var(--winui-focus-stroke-inner); }
.floway-calendar-heading:focus-visible, .floway-calendar-navigation:focus-visible { outline-offset: 0; box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner); }
@media (forced-colors: active) {
  .floway-calendar-item[data-selected] { color: Highlight; }
  .floway-calendar-item[data-selected]::before { border-color: Highlight; }
  .floway-calendar-item[data-current], .floway-calendar-item[data-current]:hover, .floway-calendar-item[data-current]:active { color: HighlightText; }
  .floway-calendar-item[data-current]::before { background-color: Highlight; }
}
`;
