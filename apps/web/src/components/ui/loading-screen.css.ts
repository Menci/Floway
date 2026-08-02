// The app's one loading surface, worn by the boot screen and by every waiting
// content region, so a wait never looks like two different products.
//
// Plain CSS because the prerendered HTML paints the boot screen before any
// Griffel rule exists; it restates the medium Spinner that ../../winui/controls/progress.css.ts
// later restyles into WinUI's ProgressRing. Each colour goes through the Fluent
// custom property that layer rewrites, with the literal beside it covering the
// frames before.
//
// No reduced-motion branch, unlike Fluent: WinUI's ProgressRing is an
// AnimatedVisualPlayer and keeps its animation with animations off.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing.xaml#L31-L32
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-spinner/library/src/components/Spinner/useSpinnerStyles.styles.ts
export const loadingCss = `
  .floway-loading {
    box-sizing: border-box;
    display: grid;
    height: 100%;
    padding: 20px;
    place-items: center;
  }
  /* Only the boot screen owns the viewport; a content region is sized by the
     layout it waits inside. */
  .floway-loading-app {
    min-height: 100dvh;
  }
  .floway-loading .fui-Spinner {
    align-items: center;
    display: flex;
    gap: 8px;
    justify-content: center;
    line-height: 0;
    min-width: min-content;
    overflow: hidden;
  }
  /* WinUI's ProgressRingStrokeThickness is 4 on a 32-square ring, but Fluent
     carries the width into a radial-gradient stop where a percentage resolves
     against the closest-side radius, so an eighth of the diameter is written as
     a quarter. The circle behind the arc stays transparent.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L5-L6
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L17
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing.xaml#L12-L13
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L219-L225
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L125-L127 */
  .floway-loading .fui-Spinner__spinner {
    --fui-Spinner--strokeWidth: 25%;
    animation: floway-loading-spin 1.5s linear infinite;
    background-color: var(--colorBrandStroke2Contrast, #ffffff00);
    color: var(--colorBrandStroke1, #0067c0);
    flex-shrink: 0;
    height: 32px;
    mask-image: radial-gradient(closest-side, transparent calc(100% - var(--fui-Spinner--strokeWidth) - 1px), white calc(100% - var(--fui-Spinner--strokeWidth)) calc(100% - 1px), transparent 100%);
    position: relative;
    width: 32px;
    -webkit-mask-image: radial-gradient(closest-side, transparent calc(100% - var(--fui-Spinner--strokeWidth) - 1px), white calc(100% - var(--fui-Spinner--strokeWidth)) calc(100% - 1px), transparent 100%);
  }
  .floway-loading .fui-Spinner__spinnerTail {
    animation: floway-loading-tail 1.5s cubic-bezier(0.33, 0, 0.67, 1) infinite;
    display: block;
    height: 100%;
    mask-image: conic-gradient(transparent 105deg, white 105deg);
    position: absolute;
    width: 100%;
    -webkit-mask-image: conic-gradient(transparent 105deg, white 105deg);
  }
  .floway-loading .fui-Spinner__spinnerTail::before,
  .floway-loading .fui-Spinner__spinnerTail::after {
    animation-duration: 1.5s;
    animation-iteration-count: infinite;
    animation-timing-function: cubic-bezier(0.33, 0, 0.67, 1);
    background-image: conic-gradient(currentcolor 135deg, transparent 135deg);
    content: '';
    display: block;
    height: 100%;
    position: absolute;
    width: 100%;
  }
  .floway-loading .fui-Spinner__spinnerTail::before {
    animation-name: floway-loading-tail-before;
  }
  .floway-loading .fui-Spinner__spinnerTail::after {
    animation-name: floway-loading-tail-after;
  }
  /* WinUI's ProgressRing has no label slot, so the label takes
     BodyTextBlockStyle rather than the subtitle2 Fluent gives a medium Spinner,
     which would read as a heading of the screen or region it is waiting in.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L4
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L23-L25 */
  .floway-loading .fui-Spinner__label {
    color: var(--colorNeutralForeground1, #000000e4);
    font-family: var(--fontFamilyBase, sans-serif);
    font-size: var(--fontSizeBase300, 14px);
    font-weight: var(--fontWeightRegular, 400);
    line-height: var(--lineHeightBase300, 20px);
  }
  /* Dark-dictionary literals for the same two tokens.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L329-L331
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L5-L9 */
  @media (prefers-color-scheme: dark) {
    .floway-loading .fui-Spinner__spinner {
      color: var(--colorBrandStroke1, #4cc2ff);
    }
    .floway-loading .fui-Spinner__label {
      color: var(--colorNeutralForeground1, #ffffff);
    }
  }
  @keyframes floway-loading-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  @keyframes floway-loading-tail {
    0% { transform: rotate(-135deg); }
    50% { transform: rotate(0deg); }
    100% { transform: rotate(225deg); }
  }
  @keyframes floway-loading-tail-before {
    0%, 100% { transform: rotate(0deg); }
    50% { transform: rotate(105deg); }
  }
  @keyframes floway-loading-tail-after {
    0%, 100% { transform: rotate(0deg); }
    50% { transform: rotate(225deg); }
  }
  /* Highlight is the accent WinUI's HighContrast dictionary names for the arc.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L12-L15 */
  @media screen and (forced-colors: active) {
    .floway-loading .fui-Spinner__spinner {
      background-color: HighlightText;
      color: Highlight;
      forced-color-adjust: none;
    }
  }
`;
