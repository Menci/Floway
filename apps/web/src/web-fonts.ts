const officeFontOrigin = 'https://res-1.cdn.office.net';
const segoeWebRoot = `${officeFontOrigin}/files/fabric-cdn-prod_20221201.001/assets/fonts/segoeui-westeuropean`;

export const segoeWebFonts = {
  semilight: `${segoeWebRoot}/segoeui-semilight.woff2`,
  regular: `${segoeWebRoot}/segoeui-regular.woff2`,
  semibold: `${segoeWebRoot}/segoeui-semibold.woff2`,
  bold: `${segoeWebRoot}/segoeui-bold.woff2`,
} as const;

export const segoeWebFontOrigin = officeFontOrigin;

export const segoeWebFontCss = Object.entries({
  300: segoeWebFonts.semilight,
  400: segoeWebFonts.regular,
  600: segoeWebFonts.semibold,
  700: segoeWebFonts.bold,
}).map(([weight, source]) => `
  @font-face {
    font-display: swap;
    font-family: 'Segoe UI Web (West European)';
    font-style: normal;
    font-weight: ${weight};
    src: url('${source}') format('woff2');
  }
`).join('');
