// The boot screen's ring, restated as plain CSS: this screen is painted by the
// prerendered index.html, before any Griffel rule exists. It matches the ring
// the app shows a moment later -- Fluent's Spinner as
// ../../winui/controls/progress.css.ts restyles it into WinUI's ProgressRing --
// with geometry and motion copied from `useSpinnerStyles` at medium. Every
// colour is spent through the same Fluent custom property that layer rewrites,
// and the literal beside it is that value written out for the frames before.
//
// Deliberately no reduced-motion branch, unlike Fluent: WinUI's ProgressRing is
// an AnimatedVisualPlayer and keeps its full animation with animations off, so
// ../../winui/controls/progress.css.ts undoes Fluent's.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing.xaml#L31-L32
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-spinner/library/src/components/Spinner/useSpinnerStyles.styles.ts
export const appLoadingCss = `
  .floway-app-loading {
    box-sizing: border-box;
    display: grid;
    height: 100%;
    min-height: 100dvh;
    padding: 20px;
    place-items: center;
  }
  .floway-app-loading .fui-Spinner {
    align-items: center;
    display: flex;
    gap: 8px;
    justify-content: center;
    line-height: 0;
    min-width: min-content;
    overflow: hidden;
  }
  /* ProgressRingStrokeThickness is 4 on WinUI's 32-square ring. Fluent carries
     the width into a radial-gradient stop, where a percentage resolves against
     the closest-side radius, so a stroke of an eighth of the diameter is
     written as a quarter of the radius. WinUI leaves the circle behind the arc
     transparent, so the arc's accent is the whole of the ring.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L5-L6
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L17
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing.xaml#L12-L13
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L219-L225
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L125-L127 */
  .floway-app-loading .fui-Spinner__spinner {
    --fui-Spinner--strokeWidth: 25%;
    animation: floway-app-loading-spin 1.5s linear infinite;
    background-color: var(--colorBrandStroke2Contrast, #ffffff00);
    color: var(--colorBrandStroke1, #0067c0);
    flex-shrink: 0;
    height: 32px;
    mask-image: radial-gradient(closest-side, transparent calc(100% - var(--fui-Spinner--strokeWidth) - 1px), white calc(100% - var(--fui-Spinner--strokeWidth)) calc(100% - 1px), transparent 100%);
    position: relative;
    width: 32px;
    -webkit-mask-image: radial-gradient(closest-side, transparent calc(100% - var(--fui-Spinner--strokeWidth) - 1px), white calc(100% - var(--fui-Spinner--strokeWidth)) calc(100% - 1px), transparent 100%);
  }
  .floway-app-loading .fui-Spinner__spinnerTail {
    animation: floway-app-loading-tail 1.5s cubic-bezier(0.33, 0, 0.67, 1) infinite;
    display: block;
    height: 100%;
    mask-image: conic-gradient(transparent 105deg, white 105deg);
    position: absolute;
    width: 100%;
    -webkit-mask-image: conic-gradient(transparent 105deg, white 105deg);
  }
  .floway-app-loading .fui-Spinner__spinnerTail::before,
  .floway-app-loading .fui-Spinner__spinnerTail::after {
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
  .floway-app-loading .fui-Spinner__spinnerTail::before {
    animation-name: floway-app-loading-tail-before;
  }
  .floway-app-loading .fui-Spinner__spinnerTail::after {
    animation-name: floway-app-loading-tail-after;
  }
  /* The label is ours: WinUI's ProgressRing carries no label slot, so the ramp
     is the one a Windows app would set a sentence in -- BodyTextBlockStyle,
     14px Normal -- rather than the subtitle2 Fluent gives a medium Spinner,
     which reads as a heading over a boot screen that has none.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L4
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L23-L25 */
  .floway-app-loading .fui-Spinner__label {
    color: var(--colorNeutralForeground1, #000000e4);
    font-family: var(--fontFamilyBase, sans-serif);
    font-size: var(--fontSizeBase300, 14px);
    font-weight: var(--fontWeightRegular, 400);
    line-height: var(--lineHeightBase300, 20px);
  }
  /* The dark dictionary's literals for the same two tokens; both halves are the
     ramp steps ../../winui/tokens.ts transcribes.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L329-L331
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L5-L9 */
  @media (prefers-color-scheme: dark) {
    .floway-app-loading .fui-Spinner__spinner {
      color: var(--colorBrandStroke1, #4cc2ff);
    }
    .floway-app-loading .fui-Spinner__label {
      color: var(--colorNeutralForeground1, #ffffff);
    }
  }
  @keyframes floway-app-loading-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  @keyframes floway-app-loading-tail {
    0% { transform: rotate(-135deg); }
    50% { transform: rotate(0deg); }
    100% { transform: rotate(225deg); }
  }
  @keyframes floway-app-loading-tail-before {
    0%, 100% { transform: rotate(0deg); }
    50% { transform: rotate(105deg); }
  }
  @keyframes floway-app-loading-tail-after {
    0%, 100% { transform: rotate(0deg); }
    50% { transform: rotate(225deg); }
  }
  /* The arc on Highlight, which is the accent WinUI's own HighContrast
     dictionary names for it.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L12-L15 */
  @media screen and (forced-colors: active) {
    .floway-app-loading .fui-Spinner__spinner {
      background-color: HighlightText;
      color: Highlight;
      forced-color-adjust: none;
    }
  }
`;
