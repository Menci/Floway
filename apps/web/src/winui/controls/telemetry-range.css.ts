export const telemetryRangeCss = `
/* Reserve both rows so range changes stay below the adjacent 62px Field
   without changing the control row's height. */
.floway-telemetry-range { display: grid; justify-items: end; grid-template-rows: 24px 34px; height: 58px; width: max-content; max-width: 100%; min-width: 0; }
.floway-telemetry-range-caption { height: 20px; max-width: 100%; min-width: 0; font-size: 12px; line-height: 20px; text-align: end; white-space: nowrap; }
.floway-telemetry-range-caption-button { display: block; max-width: 100%; padding: 0; border: 0; background: transparent; color: var(--winui-text-fill-secondary); font: inherit; white-space: nowrap; cursor: pointer; }
.floway-telemetry-range-caption-button:hover { text-decoration: underline; }
`;
