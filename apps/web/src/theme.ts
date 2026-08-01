import { fluentComponents } from './fluent';
import { baseFontStack, monospaceStack } from './font-stacks';

const { webDarkTheme, webLightTheme } = fluentComponents;

// One step of Fluent's ramp is ours: 600 drops from 24px to 22px, which is the
// size a dialog title, a card heading and a section h2 all land on here. Every
// other step is Fluent's own and is not restated -- 12/14/20 already are
// WinUI's Caption, Body and Subtitle, so there is nothing to move them to.
// https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography
const fontOverrides = {
  fontFamilyBase: baseFontStack,
  fontFamilyMonospace: monospaceStack,
  fontSizeBase600: '22px',
} as const;

export const flowayLightTheme = { ...webLightTheme, ...fontOverrides };
export const flowayDarkTheme = { ...webDarkTheme, ...fontOverrides };
