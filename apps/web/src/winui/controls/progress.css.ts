// ProgressBar restyled as WinUI 3's ProgressBar and Spinner as its ProgressRing.
//
// WinUI states the bar's two heights separately — the control is at least 3
// tall while its track is 1 — so the track is a hairline inside a box the
// indicator fills, not a filled rail. Fluent has only the root and the bar and
// paints the root itself as a full-height track, so the root's fill is restated
// as a centred 1px band and the bar keeps its role as the indicator.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L29-L30
//
// Both accents are handed over as token remaps rather than as painted colours.
// Fluent reserves the bar's own `background-color` for its error, warning and
// success variants and the ring's for `appearance="inverted"`, and each of
// those is one atom deep, so a rule painting the slot would outrank the very
// signal it is meant to leave alone. Rewriting the brand token each default
// path reads reaches exactly the default path, and leaves the indicator's
// forced-colors answer — which reads no token, and is already the Highlight
// WinUI's own high-contrast dictionary names — in force.
//
// Motion is answered per control. The ring is an AnimatedVisualPlayer running a
// Lottie composition, so its timing lives in generated animation source and not
// in the template, and Fluent's spin is kept for want of anything to
// transcribe. The bar's indeterminate storyboard is stated in full — two
// indicators over a 2s loop on a 0.4,0,0.6,1 spline, the second held until
// 0.75s — and Fluent's single sweeping segment is kept against it by choice, so
// the two controls are not left with one transcribed motion and one borrowed
// one.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing.xaml#L31-L32
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.xaml#L94-L111
export const progressCss = `
/* ProgressBarMinHeight is a floor, so it is spelled as one: Fluent's 2px medium
   rises to it and its 4px large -- a thickness WinUI never states -- is left to
   Fluent. Inside that box the track becomes a 1px band from
   ProgressBarTrackHeight, painted in ControlStrongStrokeColorDefault and
   centred. Cancelling Fluent's full-height fill is what makes the band the only
   track, and no WinUI brush says so, hence the bare keyword rather than a
   token. ProgressBarCornerRadius is 1.5 and is written as the length it is, so
   the corner holds at every thickness and whatever \`shape\` a caller asks for.
   The track's own 0.5 radius has no carrier: the band is a paint, not a box.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L23
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L29-L32 */
.fui-ProgressBar.fui-ProgressBar {
  background-color: transparent;
  background-image: linear-gradient(
    var(--winui-control-strong-stroke-default),
    var(--winui-control-strong-stroke-default)
  );
  background-position: center;
  background-repeat: no-repeat;
  background-size: 100% 1px;
  border-radius: 1.5px;
  min-height: 3px;
}

/* WinUI states the bar again in its HighContrast dictionary, and that is what
   is transcribed here: a WindowColor track inside a 1px WindowTextColor border,
   under an indicator on HighlightColor -- the Highlight Fluent already paints,
   so only the track is written. The band goes with it, because a forced-colors
   palette repaints background colours but not gradients and ours would
   otherwise survive as our own stroke colour over the system track.
   \`content-box\` keeps the 3px floor as the track's own height against the app's
   global border-box, so the border is added around the track rather than eaten
   out of it. Since a media query adds no specificity, each declaration is
   restated at the same weight as the rule above it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L12-L18 */
@media (forced-colors: active) {
  .fui-ProgressBar.fui-ProgressBar {
    background-color: Canvas;
    background-image: none;
    border: 1px solid CanvasText;
    box-sizing: content-box;
  }
}

/* The indicator takes ProgressBarForeground through the token Fluent's own
   brand fill reads, so the red, orange and green a caller asks for by color
   keep carrying their meaning. The indeterminate segment is the one shape that
   is repainted outright: Fluent fades it into its full-height track from both
   ends, and WinUI has no such track to fade into -- the indicator crosses a 1px
   line -- so the gradient goes and the accent shows through unmodulated. Only
   the brand path reaches it, because a colour needs a value and a value is
   what makes the bar determinate.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L22 */
.fui-ProgressBar__bar.fui-ProgressBar__bar {
  --colorCompoundBrandBackground: var(--winui-accent-fill-default);
  background-image: none;
}

/* Fluent draws the ring as a masked box whose background-color is the circle
   behind the arc and whose color the tail paints with. Those are ProgressRing's
   background and foreground brushes; WinUI leaves the former transparent.
   WinUI's own ring is 32 square, stroked at 4, and it states no other size, so
   the stroke is transcribed as the proportion of those two. Fluent carries the
   width into a radial-gradient stop, where a percentage resolves against the
   closest-side radius, so a stroke of an eighth of the diameter is written as a
   quarter of the radius: exactly WinUI's 4 at Fluent's 32px medium, and the
   same weight on the sizes Fluent offers beyond the one WinUI states.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L5-L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing.xaml#L12-L13
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L17
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-spinner/library/src/components/Spinner/useSpinnerStyles.styles.ts */
.fui-Spinner__spinner.fui-Spinner__spinner {
  --colorBrandStroke1: var(--winui-accent-fill-default);
  --colorBrandStroke2Contrast: var(--winui-control-fill-transparent);
  --fui-Spinner--strokeWidth: 25%;
}

/* Fluent answers the motion preference by slowing the ring to 1.8s and freezing
   the tail into a static conic gradient. WinUI answers it by doing nothing:
   ProgressRing is an AnimatedVisualPlayer, so it reaches neither
   UISettings.AnimationsEnabled nor the visual-state gate that seeks a storyboard
   to its end frame, and a Windows ring keeps its full animation with animations
   off. Each declaration below names the Fluent one it undoes.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing.xaml#L31-L32
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-spinner/library/src/components/Spinner/useSpinnerStyles.styles.ts */
@media screen and (prefers-reduced-motion: reduce) {
  .fui-Spinner__spinner.fui-Spinner__spinner {
    animation-duration: 1.5s;
  }

  .fui-Spinner__spinnerTail.fui-Spinner__spinnerTail {
    animation-iteration-count: infinite;
    background-image: none;
  }

  .fui-Spinner__spinnerTail.fui-Spinner__spinnerTail::before,
  .fui-Spinner__spinnerTail.fui-Spinner__spinnerTail::after {
    content: '';
  }
}
`;
