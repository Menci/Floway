// The boot screen's ring, restated as plain CSS.
//
// This screen is what the prerendered index.html paints, so it renders before
// any Griffel rule exists -- the component's real styles arrive with the
// bundle, which is the thing being waited for. What it has to match is not
// Fluent's spinner but the ring the app shows a moment later: Fluent's Spinner
// as ../../winui/controls/progress.css.ts restyles it into WinUI's
// ProgressRing. Geometry and motion, which carry no token, are copied from
// `useSpinnerStyles` at the medium size a bare `<Spinner label>` resolves to.
// Every colour is spent through the same Fluent custom property that layer
// rewrites, so the ring takes the layer's own value the moment the linked
// stylesheet lands, and the literal beside it is that value written out for the
// frames before -- the arrangement ../gradient-background.css.ts uses for the
// canvas underneath.
//
// The one place it does not follow Fluent is reduced motion, which Fluent
// answers by slowing the ring to 1.8s and freezing the tail into a static
// gradient. WinUI answers it by doing nothing: ProgressRing is an
// AnimatedVisualPlayer and consults neither UISettings.AnimationsEnabled nor
// the visual-state gate that seeks storyboards to their end frame, so a Windows
// ring keeps its full animation with animations off. This layer follows WinUI,
// so there is no reduce branch here and ../../winui/controls/progress.css.ts
// undoes Fluent's.
//
// A loading indicator is the case the preference is least aimed at -- it is
// small, stationary and bounded -- but it is still motion a reader asked not to
// see, so this is a real cost of the fidelity, not a free one.
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
  /* Fluent's root, which is a row: the column form is its vertical atom, and
     that atom is only added for labelPosition above or below, where the
     default is after. */
  .floway-app-loading .fui-Spinner {
    align-items: center;
    display: flex;
    gap: 8px;
    justify-content: center;
    line-height: 0;
    min-width: min-content;
    overflow: hidden;
  }
  /* ProgressRingStrokeThickness is 4 on WinUI's 32-square ring, and the ring is
     the only size WinUI states. Fluent carries the width into a radial-gradient
     stop, where a percentage resolves against the closest-side radius, so a
     stroke of an eighth of the diameter is written as a quarter of the radius
     -- the proportion ../../winui/controls/progress.css.ts states for every
     Fluent size, and 4px at the 32px medium this screen renders. WinUI leaves
     the circle behind the arc transparent, so the arc's accent is the whole of
     the ring: ControlFillColorTransparent is the same value in either
     dictionary, and the accent is the ramp step its own dictionary names.
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
  /* WinUI's ProgressRing carries no label, so the label is Fluent's and its
     type is Fluent's own for the medium size -- 16/22 semibold, not the 14/20
     of the smaller ones. Fluent leaves the colour to inherit from the provider,
     which the layer points at TextFillColorPrimary.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L209-L213 */
  /* The line under the ring is ours: WinUI's ProgressRing carries no label slot,
     so there is nothing to transcribe and the ramp is the one a Windows app
     would set a sentence in -- BodyTextBlockStyle, 14px at Normal. Fluent sets
     a medium Spinner's label in subtitle2, 16px SemiBold, which reads as a
     heading over a boot screen that has no heading.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L4
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L23-L25 */
  .floway-app-loading .fui-Spinner__label {
    color: var(--colorNeutralForeground1, #000000e4);
    font-family: var(--fontFamilyBase, sans-serif);
    font-size: var(--fontSizeBase300, 14px);
    font-weight: var(--fontWeightRegular, 400);
    line-height: var(--lineHeightBase300, 20px);
  }
  /* The dark dictionary's values for the accent arc and for the label. Each
     declaration reads the same token as the rule above it and only the literal
     changes; those literals, light and dark alike, are the steps
     ../../winui/tokens.ts transcribes, which is also where the accent ramp's
     provenance is stated.
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
  /* Forced colors is Fluent's answer, restated so the boot ring keeps it while
     the layer's rules are still on the wire -- the arc on Highlight, which is
     the accent WinUI's own HighContrast dictionary names for it.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L12-L15 */
  @media screen and (forced-colors: active) {
    .floway-app-loading .fui-Spinner__spinner {
      background-color: HighlightText;
      color: Highlight;
      forced-color-adjust: none;
    }
  }
`;
