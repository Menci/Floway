export const telemetryRangeCss = `
/* The toolbar reserves its maximum extent: the existing 34px choice row plus
   a 20px caption and 4px gap. It remains below the adjacent Field's height.
   The gap belongs inside the collapsing region, so it cannot appear at once.
   Expander supplies the asymmetric open/close durations and its cubic curve.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander.xaml#L33-L90 */
.floway-telemetry-range { display: grid; justify-items: end; grid-template-rows: 34px 1fr; height: calc(34px + 4px + 20px); width: max-content; max-width: 100%; min-width: 0; }
.floway-telemetry-range-caption { height: 0; width: 100%; min-width: 0; contain: inline-size; overflow: hidden; transition: height 167ms cubic-bezier(0.1, 0.9, 0.2, 1); }
.floway-telemetry-range-caption[data-expanded] { height: calc(4px + 20px); transition-duration: 333ms; }
.floway-telemetry-range-caption-content { box-sizing: content-box; padding-top: 4px; height: 20px; font-size: 12px; line-height: 20px; text-align: end; white-space: nowrap; }
.floway-telemetry-range-caption-content .fui-Link.fui-Link { font-size: inherit; line-height: inherit; white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .floway-telemetry-range-caption, .floway-telemetry-range-caption[data-expanded] { transition-duration: 0.01ms; } }
`;
