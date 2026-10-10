import { focusRectStrokes } from '../focus-rect.css';

export const calendarRangeCss = `
/* Syncfusion.Calendar.WinUI 35.1.39 original Themes/calendar.xaml,
   calendarheader.xaml, navigationbutton.xaml and calendaritem.xaml; Core's
   Standard density supplies the 40px minimum slots. The range presenter keeps
   its 1px separator column even when the separator and presets are collapsed.
   https://www.nuget.org/packages/Syncfusion.Calendar.WinUI/35.1.39 */
.fui-PopoverSurface.fui-PopoverSurface.floway-date-range-surface {
  --floway-range-cell-size: 40px;
  padding: 0 1px 0 0;
  border: 1px solid var(--winui-surface-stroke-flyout);
  border-radius: var(--winui-overlay-corner-radius);
  width: calc(7 * var(--floway-range-cell-size) + 2 * 2px + 1px + 2 * 1px);
  box-sizing: border-box;
  max-width: 100vw;
  background-color: var(--winui-acrylic-in-app-fill-default);
  overflow: hidden;
}
.floway-range-calendar { width: calc(7 * var(--floway-range-cell-size) + 2 * 2px); font: 14px var(--fontFamilyBase); color: var(--winui-text-fill-primary); }
.floway-range-header { display: grid; grid-template-columns: auto 1fr auto; height: calc(var(--floway-range-cell-size) + 1px); box-sizing: border-box; border-bottom: 1px solid var(--winui-card-stroke-default); }
.floway-range-header button { position: relative; display: grid; place-items: center; box-sizing: border-box; padding: 0; border: 0; margin: 0; height: var(--floway-range-cell-size); background: transparent; color: var(--winui-control-strong-fill-default); font: inherit; cursor: pointer; isolation: isolate; }
.floway-range-header button::before { content: ''; position: absolute; z-index: -1; inset: 2px 5px; border: 1px solid transparent; border-radius: 3px; }
.floway-range-header button:hover:enabled::before { background: var(--winui-subtle-fill-secondary); }
.floway-range-header button:active:enabled::before { background: var(--winui-subtle-fill-tertiary); }
.floway-range-header button:disabled { color: var(--winui-text-fill-disabled); cursor: default; }
.floway-range-header .floway-range-heading { justify-self: center; width: max-content; padding-inline: calc(5px + 1px + 11px); color: var(--winui-text-fill-primary); font-weight: 600; }
.floway-range-heading:active:enabled { color: var(--winui-text-fill-secondary); }
.floway-range-navigation { width: calc(2 * (5px + 1px + 11px) + 8px); }
.floway-range-navigation svg, .floway-range-navigation span { width: 8px; height: 8px; font-size: 8px; line-height: 8px; }
.floway-range-viewport { position: relative; width: calc(7 * var(--floway-range-cell-size)); height: calc(7 * var(--floway-range-cell-size)); margin: 2px 2px 0; overflow: hidden; background: var(--winui-layer-fill-default); }
.floway-range-view { width: 100%; height: 100%; transform-origin: center; }
.floway-range-weekdays { display: grid; grid-template-columns: repeat(7, 1fr); height: var(--floway-range-cell-size); }
.floway-range-weekdays span { display: grid; place-items: center; font-size: 14px; line-height: 14px; font-weight: 600; color: var(--winui-text-base-medium-high); }
.floway-range-grid { display: grid; width: 100%; height: calc(6 * var(--floway-range-cell-size)); }
.floway-range-calendar:not([data-view='month']) .floway-range-grid { height: 100%; }
.floway-range-row { display: contents; }
.floway-range-cell { display: grid; place-items: center; position: relative; min-width: 0; min-height: 0; box-sizing: border-box; border: 0; margin: 0; padding: 0; background: transparent; color: inherit; font: inherit; font-weight: 400; line-height: 14px; cursor: pointer; }
.floway-range-cell > span { z-index: 1; white-space: pre-line; text-align: center; }
.floway-range-cell[data-outside] { visibility: hidden; }
.floway-range-cell:disabled { color: var(--winui-text-fill-disabled); cursor: default; }
.floway-range-cell-paint { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.floway-range-circle { fill: transparent; stroke: transparent; }
.floway-range-band { fill: var(--winui-subtle-fill-secondary); }
.floway-range-cell:hover:enabled:not([data-endpoint]) .floway-range-circle { fill: var(--winui-subtle-fill-secondary); }
.floway-range-cell:active:enabled:not([data-endpoint]) .floway-range-circle { fill: var(--winui-subtle-fill-tertiary); }
.floway-range-cell[data-today]:not([data-endpoint]):not([data-in-range]) { color: var(--winui-text-on-accent-fill-primary); }
.floway-range-cell[data-today]:not([data-endpoint]):not([data-in-range]) .floway-range-circle { fill: var(--winui-system-accent); }
.floway-range-cell[data-today]:hover:not([data-endpoint]):not([data-in-range]) .floway-range-circle { fill: var(--winui-system-accent-light-1); }
.floway-range-cell[data-today]:active:not([data-endpoint]):not([data-in-range]) { color: var(--winui-text-on-accent-fill-secondary); }
.floway-range-cell[data-today]:active:not([data-endpoint]):not([data-in-range]) .floway-range-circle { fill: var(--winui-system-accent-light-2); }
.floway-range-cell[data-endpoint] { color: var(--winui-system-accent-dark-1); }
.floway-range-cell[data-endpoint] .floway-range-circle { stroke: var(--winui-system-accent); }
.floway-range-cell[data-endpoint]:hover .floway-range-circle { stroke: var(--winui-system-accent-light-1); fill: var(--winui-subtle-fill-secondary); }
.floway-range-cell[data-endpoint]:active .floway-range-circle { stroke: transparent; fill: var(--winui-subtle-fill-tertiary); }
.floway-range-cell[data-endpoint][data-single][data-today] { color: var(--winui-text-on-accent-fill-primary); }
.floway-range-cell[data-endpoint][data-single][data-today] .floway-range-circle { fill: transparent; }
.floway-range-inner-circle { display: none; fill: var(--winui-system-accent); stroke: transparent; }
.floway-range-cell[data-endpoint][data-single][data-today] .floway-range-inner-circle { display: block; }
.floway-range-cell[data-endpoint][data-today]:hover { color: var(--winui-text-on-accent-fill-primary); }
.floway-range-cell[data-endpoint][data-today]:hover .floway-range-circle { fill: transparent; }
.floway-range-cell[data-endpoint][data-today]:hover .floway-range-inner-circle { display: block; fill: var(--winui-system-accent-light-1); }
.floway-range-cell[data-endpoint][data-today]:active .floway-range-circle { stroke: var(--winui-system-accent-light-2); }
.floway-range-cell[data-endpoint][data-today]:active .floway-range-inner-circle { fill: var(--winui-system-accent-light-2); }
.floway-range-cell:focus-visible, .floway-range-header button:focus-visible { ${focusRectStrokes} }
.floway-range-snapshots { position: absolute; inset: 0; pointer-events: none; }
.floway-range-snapshot { position: absolute; left: 0; transform-origin: center; pointer-events: none; }
@media (forced-colors: active) {
  .floway-range-cell[data-endpoint] { color: Highlight; }
  .floway-range-cell[data-endpoint] .floway-range-circle { stroke: Highlight; }
  .floway-range-band { fill: ButtonFace; }
}
`;
