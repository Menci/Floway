export const dateTimePickerCss = `
/* AnalogClock is the reference's default composition. The calendar owns its
   left border, and the clock owns the remaining three sides.
   https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Themes/Styles/Controls/CalendarWithClockStyle.xaml#L29-L109
   https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Controls/Native/Date/CalendarWithClock/CalendarWithClock.cs#L324-L343 */
.fui-PopoverSurface.fui-PopoverSurface.floway-date-time-picker-surface {
  padding: 0;
  border-width: 0;
  border-radius: var(--winui-control-corner-radius);
  max-width: 100vw;
}
.floway-date-time-picker-body { display: grid; grid-template-columns: minmax(300px, 1fr) auto; border-radius: var(--winui-control-corner-radius); }
.floway-date-time-picker-body .floway-calendar { width: 300px; border: 1px solid var(--winui-control-stroke-default); border-right: 0; }
/* Clock's 250px Viewbox is a uniform scale of its 178px face plus 10px
   margins. The minute hand and hour circles share those natural coordinates;
   its background reads CalendarViewBackground's input-active brush.
   https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Themes/Styles/Controls/Clock.xaml#L25-L85
   https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Themes/Styles/Controls/ClockRadioButton.xaml#L8-L94 */
.floway-clock { position: relative; display: grid; grid-template-rows: 49.5px 1fr 40px; width: 250px; min-height: calc(49.5px + 250px + 40px); box-sizing: border-box; border: 0; border-radius: 0 4px 4px 0; background-color: var(--winui-control-fill-input-active); font: 14px var(--fontFamilyBase); }
.floway-clock::before { content: ''; position: absolute; inset: 0; border: 1px solid var(--winui-control-stroke-default); border-left: 0; border-radius: inherit; pointer-events: none; }
.floway-clock-title { display: block; margin: 5px 4px 4px 0; padding: 0; border: 0; border-radius: 0 8px 8px 0; background-color: var(--winui-accent-fill-default); color: var(--winui-text-on-accent-fill-primary); font: inherit; font-size: 20px; text-align: center; cursor: pointer; }
.floway-clock-viewbox { position: relative; width: 250px; height: 250px; align-self: center; }
.floway-clock-canvas { width: 198px; height: 198px; transform-origin: top left; padding: 10px; box-sizing: border-box; }
.floway-clock-face { position: relative; width: 178px; height: 178px; background-color: var(--winui-card-background-fill-secondary); border-radius: 90px; touch-action: none; }
.floway-clock-hour { position: absolute; display: grid; place-items: center; width: 30px; height: 30px; transform: translate(-50%, -50%); padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--winui-text-fill-primary); font: inherit; font-weight: 600; cursor: pointer; }
.floway-clock-hour[aria-checked='true'] { background-color: var(--winui-accent-fill-default); color: var(--winui-text-on-accent-fill-primary); }
.floway-clock-hand { position: absolute; inset: 0; width: 178px; height: 178px; pointer-events: none; color: var(--winui-accent-fill-default); }
/* Native minute focus is painted on the hand, rather than around the face.
   https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Controls/Native/Date/Clock/Clock.cs#L234-L250 */
.floway-clock-minute-focus:focus-visible { outline: none; box-shadow: none; }
.floway-clock-minute-focus { position: absolute; inset: 0; pointer-events: none; }
.floway-clock-face:has(.floway-clock-minute-focus:focus-visible) .floway-clock-hand line { stroke: black; stroke-width: 4px; }
.floway-clock-period { display: contents; }
.floway-clock-period button { position: absolute; bottom: 5.5px; display: grid; place-items: center; width: 44px; min-width: 120px; height: 44px; padding: 0; border: 0; background: transparent; color: var(--winui-text-fill-primary); font: inherit; font-weight: 600; cursor: pointer; isolation: isolate; }
.floway-clock-period button::before { content: ''; position: absolute; z-index: -1; width: 35px; height: 35px; border-radius: 50%; background: transparent; }
.floway-clock-period button[aria-checked='true']::before { background-color: var(--winui-accent-fill-default); }
.floway-clock-period button[aria-checked='true'] { color: var(--winui-text-on-accent-fill-primary); }
/* Native RadioButton inherits MinWidth=120 even when Width=44. Keeping
   that floor positions the 35px painted circles inside the clock with the
   reference's negative margins: their centers are 120/2 - 34.5 = 25.5px.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml
   https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Themes/Styles/Controls/Clock.xaml#L84-L85 */
.floway-clock-am { left: -34.5px; }
.floway-clock-pm { right: -34.5px; }
.floway-clock-hour:focus-visible, .floway-clock-period button:focus-visible::before { outline: 2.5px solid var(--winui-text-fill-primary); outline-offset: -2.5px; }
.floway-clock-hour:disabled, .floway-clock-period button:disabled { color: var(--winui-text-fill-disabled); cursor: default; }
.floway-clock-title:focus-visible { outline: 2px solid var(--winui-focus-stroke-outer); outline-offset: -2px; }
@media (prefers-color-scheme: dark) {
  .floway-clock-face { background-color: var(--winui-control-fill-tertiary); }
  .floway-clock-face:has(.floway-clock-minute-focus:focus-visible) .floway-clock-hand line { stroke: white; }
}
@media (max-width: 552px) {
  .floway-date-time-picker-body { grid-template-columns: 1fr; }
  .floway-date-time-picker-body .floway-calendar { border-right: 1px solid var(--winui-control-stroke-default); border-radius: 4px 4px 0 0; }
  .floway-date-time-picker-body .floway-clock { width: 300px; border-radius: 0 0 4px 4px; }
  .floway-date-time-picker-body .floway-clock::before { border-left: 1px solid var(--winui-control-stroke-default); border-top: 0; }
  .floway-clock-viewbox { justify-self: center; }
  .floway-clock-title { margin: 4px; border-radius: 8px; }
  .floway-clock-am { left: -34.5px; }
  .floway-clock-pm { right: -34.5px; }
}
/* Native TimePicker: column faceplate, centered wheel highlight and footer.
   Text keeps natural metrics; 40px belongs to selector slots, not the button.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TimePicker_themeresources.xaml#L113-L307 */
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
.floway-time-picker-wheel { height: var(--floway-picker-viewport-height); min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; box-sizing: border-box; }
.floway-time-picker-plane { position: relative; height: calc(var(--floway-picker-viewport-height) + 1001 * 40px); }
.floway-time-picker-wheel .floway-time-picker-item { position: absolute; left: 0; right: 0; }
.floway-time-picker-wheel::-webkit-scrollbar { display: none; }
.floway-time-picker-item { display: grid; box-sizing: border-box; height: 40px; width: 100%; margin: 0; padding: 0; border: 0; background: transparent; color: var(--winui-text-fill-primary); font: inherit; cursor: pointer; }
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
