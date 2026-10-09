// CalendarView day items have a 40px floor and 1px margins. The calendar's
// width derives from those seven columns and Fluent's own 12px body inset.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CalendarView_themeresources.xaml#L243-L253
// https://github.com/microsoft/fluentui/blob/a51547435d0a5c4a0fb15c2996c3d3efea5b49dd/packages/react-components/react-calendar-compat/library/src/components/CalendarDay/useCalendarDayStyles.styles.ts
export const calendarCss = `
.fui-Calendar.fui-Calendar {
  --floway-calendar-day-size: 40px;
  --floway-calendar-day-margin: 1px;
  --floway-calendar-body-inset: 12px;
  --floway-calendar-grid-width: calc(7 * (var(--floway-calendar-day-size) + 2 * var(--floway-calendar-day-margin)));
  width: calc(var(--floway-calendar-grid-width) + 2 * var(--floway-calendar-body-inset));
}
.fui-CalendarDay.fui-CalendarDay,
.fui-CalendarDayGrid__table.fui-CalendarDayGrid__table {
  width: var(--floway-calendar-grid-width);
}
.fui-CalendarDayGrid__dayCell.fui-CalendarDayGrid__dayCell {
  padding: var(--floway-calendar-day-margin);
  background-color: transparent;
  font-size: var(--fontSizeBase300);
}
/* Rounded chrome derives its circle from half the item size. Selected dates
   use an accent outline and accent text; today uses a filled accent circle.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/specs/CalendarView/CalendarViewSpec1.md#L348-L352
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CalendarView_themeresources.xaml#L6-L46 */
.fui-CalendarDayGrid__dayCell.fui-CalendarDayGrid__dayCell.fui-CalendarDayGrid__hoverStyle,
.fui-CalendarDayGrid__dayCell.fui-CalendarDayGrid__dayCell.fui-CalendarDayGrid__pressedStyle {
  background-color: transparent;
}
.fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayButton {
  min-width: var(--floway-calendar-day-size);
  min-height: var(--floway-calendar-day-size);
  width: 100%;
  height: auto;
  border: 1px solid transparent;
  /* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CalendarView_themeresources.xaml#L243-L247 */
  padding: 0 0 4px 0;
  border-radius: 50%;
  background-color: transparent;
  color: var(--winui-text-fill-primary);
  font-size: var(--fontSizeBase300);
}
.fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayButton:hover {
  background-color: var(--winui-subtle-fill-secondary);
}
.fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayButton:active {
  background-color: var(--winui-subtle-fill-tertiary);
}
.fui-CalendarDayGrid__dayOutsideNavigatedMonth > .fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayButton {
  color: var(--winui-text-fill-secondary);
}
.fui-CalendarDayGrid__daySingleSelected > .fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayButton {
  border-color: var(--winui-accent-fill-default);
  border-radius: 50%;
  background-color: transparent;
  color: var(--winui-accent-text-fill-primary);
}
.fui-CalendarDayGrid__daySingleSelected > .fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayButton:hover {
  border-color: var(--winui-accent-fill-secondary);
  background-color: var(--winui-subtle-fill-secondary);
}
.fui-CalendarDayGrid__daySingleSelected > .fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayButton:active {
  border-color: var(--winui-subtle-fill-tertiary);
  background-color: var(--winui-subtle-fill-tertiary);
  color: var(--winui-accent-text-fill-tertiary);
}
.fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayIsToday {
  background-color: var(--winui-accent-fill-default);
  color: var(--winui-text-on-accent-fill-primary);
}
.fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayIsToday:hover {
  background-color: var(--winui-accent-fill-secondary);
}
.fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayIsToday:active {
  background-color: var(--winui-accent-fill-tertiary);
}
/* Rounded chrome's selected-today inner border is 1px.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/core/elements/CalendarViewBaseItemChrome.cpp#L30 */
.fui-CalendarDayGrid__daySingleSelected > .fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayIsToday {
  box-shadow: inset 0 0 0 1px var(--winui-text-on-accent-fill-primary);
}
/* FocusVisualPrimaryThickness=2 and FocusVisualSecondaryThickness=1.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CalendarView_themeresources.xaml#L249-L253 */
.fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayButton:focus-visible {
  outline: 2px solid var(--winui-focus-stroke-outer);
  box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
}
/* Month and year selectors share CalendarView's item brushes and rounded
   chrome. Their sizing remains Fluent's four-column picker layout.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/specs/CalendarView/CalendarViewSpec1.md#L348-L352
   https://github.com/microsoft/fluentui/blob/a51547435d0a5c4a0fb15c2996c3d3efea5b49dd/packages/react-components/react-calendar-compat/library/src/components/CalendarPicker/useCalendarPickerStyles.styles.ts */
.fui-CalendarPicker.fui-CalendarPicker {
  width: var(--floway-calendar-grid-width);
}
.fui-CalendarPicker__buttonRow.fui-CalendarPicker__buttonRow {
  display: flex;
}
.fui-CalendarPicker__itemButton.fui-CalendarPicker__itemButton {
  flex: 1;
  width: auto;
  border: 1px solid transparent;
  border-radius: calc(var(--floway-calendar-day-size) / 2);
  background-color: transparent;
  color: var(--winui-text-fill-primary);
  font-size: var(--fontSizeBase300);
}
.fui-CalendarPicker__itemButton.fui-CalendarPicker__itemButton:hover {
  background-color: var(--winui-subtle-fill-secondary);
}
.fui-CalendarPicker__itemButton.fui-CalendarPicker__itemButton:active {
  background-color: var(--winui-subtle-fill-tertiary);
}
.fui-CalendarPicker__itemButton.fui-CalendarPicker__itemButton.fui-CalendarPicker__selected {
  border-color: var(--winui-accent-fill-default);
  background-color: transparent;
  color: var(--winui-accent-text-fill-primary);
}
.fui-CalendarPicker__itemButton.fui-CalendarPicker__itemButton.fui-CalendarPicker__current {
  background-color: var(--winui-accent-fill-default);
  color: var(--winui-text-on-accent-fill-primary);
}
@media (forced-colors: active) {
  .fui-CalendarDayGrid__daySingleSelected > .fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayButton {
    border-color: Highlight;
    color: Highlight;
  }
  .fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayButton.fui-CalendarDayGrid__dayIsToday {
    background-color: Highlight;
    color: HighlightText;
  }
}
`;
