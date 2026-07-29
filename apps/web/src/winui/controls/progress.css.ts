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
// path reads reaches exactly the default path, and leaves Fluent's
// forced-colors answers — which read no token — in force.
//
// Neither dictionary states motion — no indeterminate geometry, no durations,
// no spin — so every animation in both controls stays Fluent's, as does the
// Spinner's stroke width: ProgressRingStrokeThickness is 4, but the dictionary
// names no diameter to scale it against.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L17
export const progressCss = `
/* ProgressBarMinHeight is a floor, so it is spelled as one: Fluent's 2px medium
   rises to it and its 4px large — a thickness WinUI never states — is left to
   Fluent. Inside that box the track becomes a 1px band from
   ProgressBarTrackHeight, painted in ControlStrongStrokeColorDefault and
   centred. Cancelling Fluent's full-height fill is what makes the band the only
   track, and no WinUI brush says so, hence the bare keyword rather than a
   token. Neither shape needs a radius rule either: WinUI's 1.5 is exactly the
   clamp a browser applies to Fluent's rounded 4px against a 3px box, and its
   square shape already carries none.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L23
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L29-L31 */
.fui-ProgressBar.fui-ProgressBar {
  background-color: transparent;
  background-image: linear-gradient(
    var(--winui-control-strong-stroke-default),
    var(--winui-control-strong-stroke-default)
  );
  background-position: center;
  background-repeat: no-repeat;
  background-size: 100% 1px;
  min-height: 3px;
}

/* A forced-colors palette repaints background colours but not gradients, so the
   band would survive as our own stroke colour over the CanvasText track Fluent
   asks for. Both halves of the band are withdrawn here, and since a media query
   adds no specificity, Fluent's own answer is restated at the same weight as
   the rule above it. */
@media (forced-colors: active) {
  .fui-ProgressBar.fui-ProgressBar {
    background-color: CanvasText;
    background-image: none;
  }
}

/* The indicator takes ProgressBarForeground through the token Fluent's own
   brand fill reads, so the red, orange and green a caller asks for by color
   keep carrying their meaning. The indeterminate segment is the one shape that
   is repainted outright: Fluent fades it into its full-height track from both
   ends, and WinUI has no such track to fade into — the indicator crosses a 1px
   line — so the gradient goes and the accent shows through unmodulated. Only
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
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L5-L6 */
.fui-Spinner__spinner.fui-Spinner__spinner {
  --colorBrandStroke1: var(--winui-accent-fill-default);
  --colorBrandStroke2Contrast: var(--winui-control-fill-transparent);
}
`;
