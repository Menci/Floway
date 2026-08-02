import { fluentComponents } from './fluent';
import { baseFontStack, monospaceStack } from './font-stacks';

const { webDarkTheme, webLightTheme } = fluentComponents;

// One step of Fluent's ramp is ours: 600 drops from 24px to 22px, on Fluent's
// unchanged 32px leading. WinUI's ramp steps from Subtitle 20 straight to Title
// 28, so neither 24 nor 22 transcribes anything, and nothing sources the 22
// either -- it is ours, spent on the one surface that reaches this step, the
// playground markdown h1. Every other step is Fluent's own and is not
// restated: 12/14/20 already are WinUI's Caption, Body and Subtitle, so there
// is nothing to move them to.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L3-L9
const fontOverrides = {
  fontFamilyBase: baseFontStack,
  fontFamilyMonospace: monospaceStack,
  fontSizeBase600: '22px',
} as const;

export const flowayLightTheme = { ...webLightTheme, ...fontOverrides };
export const flowayDarkTheme = { ...webDarkTheme, ...fontOverrides };
