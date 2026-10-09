export const dateTimePickerCss = `
/* DateTimePicker uses a padding-free FlyoutPresenter and an inner 1px border
   in TimePicker mode. Its calendar has no border; the time picker is centered
   at the right with a 5px margin on every side.
   https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Themes/Styles/Controls/DateTimePicker.xaml#L130-L167
   https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Controls/Native/Date/DateTimePicker/DateTimePicker.cs#L220-L229
   https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Controls/Native/Date/CalendarWithClock/CalendarWithClock.cs#L273-L289 */
.fui-PopoverSurface.fui-PopoverSurface.floway-date-time-picker-surface {
  padding: 0;
  border-width: 0;
  border-radius: var(--winui-control-corner-radius);
  max-width: 100vw;
}
.floway-date-time-picker-body { display: grid; grid-template-columns: 1fr auto; border: 1px solid; border-color: var(--winui-control-elevation-border-color); border-radius: var(--winui-control-corner-radius); }
.floway-date-time-picker-time { display: grid; align-items: center; margin: 5px; }
/* On a viewport narrower than the Right composition, use the reference's
   Bottom composition and its own corner assignments.
   https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Controls/Native/Date/CalendarWithClock/CalendarWithClock.cs#L246-L270 */
@media (max-width: 552px) {
  .floway-date-time-picker-body { grid-template-columns: 1fr; }
  .floway-date-time-picker-time { justify-content: center; }
  .floway-date-time-picker-body .floway-calendar { border-radius: 4px 4px 0 0; }
}
/* Native TimePicker: column faceplate, centered wheel highlight and footer.
   Text keeps natural metrics; 40px belongs to selector slots, not the button.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TimePicker_themeresources.xaml#L113-L307 */
.floway-time-picker { display: grid; grid-template-columns: 1fr 1fr; min-width: 242px; max-width: 456px; padding: 0; border: 1px solid; border-color: var(--winui-control-elevation-border-color); border-radius: var(--winui-control-corner-radius); background-color: var(--winui-control-fill-default); color: var(--winui-text-fill-primary); font-family: var(--fontFamilyBase); font-size: 14px; line-height: normal; cursor: pointer; }
.floway-time-picker > span { padding: 3px 0 6px; text-align: center; }
.floway-time-picker > span + span { border-left: 1px solid var(--winui-control-stroke-default); }
.floway-time-picker:hover { background-color: var(--winui-control-fill-secondary); }
.floway-time-picker:active { border-color: var(--winui-control-stroke-default); background-color: var(--winui-control-fill-tertiary); color: var(--winui-text-fill-secondary); }
.floway-time-picker:focus-visible { outline: 2px solid var(--winui-focus-stroke-outer); outline-offset: 1px; box-shadow: 0 0 0 1px var(--winui-focus-stroke-inner); }
.fui-PopoverSurface.fui-PopoverSurface.floway-time-picker-surface {
  --floway-picker-height: min(398px, 100dvh);
  --floway-picker-viewport-height: calc(var(--floway-picker-height) - 2px - 41px);
  --floway-picker-center-offset: -20.5px;
  --floway-picker-open-half: calc(var(--floway-picker-height) / 4);
  --floway-picker-full-half: calc(var(--floway-picker-height) / 2 + 20.5px);
  --floway-picker-close-half: calc(var(--floway-picker-height) * 0.075);
  height: var(--floway-picker-height);
  max-height: 398px;
  width: var(--fui-match-target-size, 242px);
  min-width: var(--fui-match-target-size, 242px);
  padding: 0;
  border: 1px solid var(--winui-surface-stroke-flyout);
  border-radius: var(--winui-control-corner-radius);
  background-color: var(--winui-acrylic-in-app-fill-default);
  font-family: var(--fontFamilyBase);
  font-size: 14px;
  line-height: normal;
}
.floway-time-picker-selection { position: absolute; z-index: 0; left: 4px; right: 4px; top: calc(var(--floway-picker-viewport-height) / 2 - 20px); height: 40px; border-radius: var(--winui-control-corner-radius); background-color: var(--winui-accent-fill-default); }
.floway-time-picker-columns { position: relative; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: minmax(0, 1fr); height: var(--floway-picker-viewport-height); }
.floway-time-picker-column { position: relative; min-width: 0; min-height: 0; }
.floway-time-picker-column + .floway-time-picker-minute { border-left: 1px solid var(--winui-divider-stroke-default); }
.floway-time-picker-wheel { height: var(--floway-picker-viewport-height); min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; scroll-snap-type: y mandatory; box-sizing: border-box; }
.floway-time-picker-plane { position: relative; height: calc(var(--floway-picker-viewport-height) + 1001 * 40px); }
.floway-time-picker-wheel .floway-time-picker-item { position: absolute; left: 0; right: 0; }
.floway-time-picker-wheel::-webkit-scrollbar { display: none; }
.floway-time-picker-item { display: grid; box-sizing: border-box; height: 40px; width: 100%; margin: 0; padding: 0; border: 0; background: transparent; color: var(--winui-text-fill-primary); font: inherit; scroll-snap-align: center; cursor: pointer; }
.floway-time-picker-item > span { display: grid; place-items: center; margin: 2px 4px; padding: 3px 2px 6px; }
/* MonochromaticOverlayPresenter recolors glyphs only inside the fixed stripe.
   Subtract each slot's local position from the stripe and add the wheel's
   scroll offset, so clipping and the positioned flyout cannot move the mask.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TimePicker_themeresources.xaml#L289-L297 */
.floway-time-picker-item > span {
  --floway-picker-text-stripe-top: calc((var(--floway-picker-viewport-height) - 40px) / 2 - var(--floway-picker-item-top, calc((var(--floway-picker-viewport-height) - 40px) / 2)) + var(--floway-picker-scroll-top, 0px) - 2px);
  color: transparent;
  background-image: linear-gradient(to bottom,
    var(--winui-text-fill-primary) var(--floway-picker-text-stripe-top),
    var(--winui-text-on-accent-fill-primary) var(--floway-picker-text-stripe-top),
    var(--winui-text-on-accent-fill-primary) calc(var(--floway-picker-text-stripe-top) + 40px),
    var(--winui-text-fill-primary) calc(var(--floway-picker-text-stripe-top) + 40px));
  background-clip: text;
}
.floway-time-picker-item:hover:not([aria-selected='true']) > span { background-color: var(--winui-subtle-fill-secondary); }
.floway-time-picker-minute { display: grid; align-content: center; }
/* Native navigation buttons appear without a fade, then press their glyph
   discretely to 0.875 after 16ms.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/DateTimePickerFlyout_themeresources.xaml#L74-L77
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/DateTimePickerFlyout_themeresources.xaml#L176-L266 */
.floway-time-picker-repeat { display: none; position: absolute; z-index: 1; left: 0; right: 0; height: 34px; border: 0; padding: 0; margin: 0; background-color: var(--winui-acrylic-in-app-fill-default); color: var(--winui-text-fill-secondary); }
.floway-time-picker-column:hover .floway-time-picker-repeat { display: grid; place-items: center; }
.floway-time-picker-repeat-up { top: 0; }
.floway-time-picker-repeat-down { bottom: 0; }
.floway-time-picker-repeat svg { width: 8px; height: 8px; }
.floway-time-picker-repeat:hover, .floway-time-picker-repeat:active { background-color: transparent; color: var(--winui-text-fill-primary); }
.floway-time-picker-repeat:active svg { animation: floway-picker-arrow-pressed 16ms step-end forwards; }
@keyframes floway-picker-arrow-pressed { to { transform: scale(0.875); } }
.floway-time-picker-footer { display: grid; grid-template-columns: 1fr 1fr; height: 41px; box-sizing: border-box; border-top: 1px solid var(--winui-divider-stroke-default); }
.floway-time-picker-footer button { display: grid; place-items: center; border: 0; padding: 4px; margin: 4px 4px 4px 2px; border-radius: var(--winui-control-corner-radius); background: transparent; color: var(--winui-text-fill-primary); }
.floway-time-picker-footer button:hover { background-color: var(--winui-subtle-fill-secondary); }
.floway-time-picker-footer button:active { background-color: var(--winui-subtle-fill-tertiary); color: var(--winui-text-fill-secondary); }
`;
