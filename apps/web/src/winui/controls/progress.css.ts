// ProgressBar restyled as WinUI 3's ProgressBar and Spinner as its ProgressRing.
//
// WinUI states the bar's two heights separately — the control is at least 3
// tall while its track is 1 — so the track is a hairline inside a box the
// indicator fills, not a filled rail. Fluent has only the root and the bar and
// paints the root itself as a full-height track, so the root's fill is restated
// as a centred 1px band and the bar keeps its role as the indicator.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L29-L30
//
// Every colour is handed over as a token remap rather than as a painted slot.
// Fluent reserves the bar's own `background-color` for its error, warning and
// success variants and the ring's for `appearance="inverted"`, and each of
// those is one atom deep, so a rule painting the slot would outrank the very
// signal it is meant to carry.
//
// Motion is left to Fluent for both controls. The ring's timing lives in a
// Lottie composition rather than the template, so there is nothing to
// transcribe; the bar's indeterminate storyboard is transcribable and simply
// not spent.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing.xaml#L31-L32
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.xaml#L94-L111
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.xaml#L20-L24
export const progressCss = `
/* ProgressBarMinHeight is a floor, so it is spelled as one: Fluent's 2px medium
   rises to it and its 4px large -- a thickness WinUI never states -- is left to
   Fluent. Cancelling Fluent's full-height fill is what makes the 1px band the
   only track, and no WinUI brush says so, hence the bare keyword rather than a
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

/* An indeterminate bar has no track at all: every WinUI state that runs the
   travelling indicators takes ProgressBarTrack.Opacity to 0. The state reaches
   the DOM through ARIA rather than through a class, because Fluent writes
   aria-valuenow only when a value exists (useProgressBar.js,
   useProgressBarBase_unstable), and its absence is what indeterminate means.
   Only the band is dropped; the box, its floor and its radius stay, since
   WinUI hides the track rectangle and not the control.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.xaml#L94-L99
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.xaml#L113-L119
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.xaml#L133-L139 */
.fui-ProgressBar.fui-ProgressBar:not([aria-valuenow]) {
  background-image: none;
}

/* High contrast. The band is dropped too, because a forced-colors palette
   repaints background colours but not gradients and ours would otherwise
   survive as our own stroke colour over the system track. \`content-box\` keeps
   the 3px floor as the track's own height against the app's global border-box,
   so the border is added around the track rather than eaten out of it. A media
   query adds no specificity, so each declaration is restated at the same weight
   as the rule above it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L12-L18 */
@media (forced-colors: active) {
  .fui-ProgressBar.fui-ProgressBar {
    background-color: Canvas;
    background-image: none;
    border: 1px solid CanvasText;
    box-sizing: content-box;
  }
}

/* The indicator and its status variants take the SystemFill ramp: WinUI paints
   an errored indicator SystemFillColorCritical and a paused one
   SystemFillColorCaution, which are the states Fluent spells \`error\` and
   \`warning\`. WinUI's ProgressBar has no third status, so \`success\` is
   pointed at SystemFillColorSuccess for agreement with the message a Field
   prints beside it.

   The indeterminate segment is repainted outright: Fluent fades it into its
   full-height track from both ends, and WinUI has no such track to fade into.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L22
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L25-L26
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L9-L10
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L280
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L76 */
.fui-ProgressBar__bar.fui-ProgressBar__bar {
  --colorCompoundBrandBackground: var(--winui-accent-fill-default);
  --colorPaletteDarkOrangeBackground3: var(--winui-system-fill-caution);
  --colorPaletteGreenBackground3: var(--winui-system-fill-success);
  --colorPaletteRedBackground3: var(--winui-system-fill-critical);
  background-image: none;
}

/* WinUI's ring is 32 square, stroked at 4, and it states no other size, so the
   stroke is transcribed as the proportion of those two. Fluent carries the
   width into a radial-gradient stop, where a percentage resolves against the
   closest-side radius, so a stroke of an eighth of the diameter is written as a
   quarter of the radius: exactly WinUI's 4 at Fluent's 32px medium, and the
   same weight on the sizes Fluent offers beyond the one WinUI states.

   Forced colours are Fluent's answer here: WinUI's high-contrast pair names
   SystemControlBackgroundBaseLowBrush, a framework alias no dictionary in
   microsoft-ui-xaml gives a high-contrast value for.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L5-L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing.xaml#L12-L13
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L17
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L12-L14
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-spinner/library/src/components/Spinner/useSpinnerStyles.styles.ts#L44-L56 */
.fui-Spinner__spinner.fui-Spinner__spinner {
  --colorBrandStroke1: var(--winui-accent-fill-default);
  --colorBrandStroke2Contrast: var(--winui-control-fill-transparent);
  --fui-Spinner--strokeWidth: 25%;
}

/* A ring inside a button takes that button's foreground. WinUI states the
   ring's Foreground as a Style setter rather than a fixed brush -- an
   instance-overridable default -- and currentColor is that override written
   once for every appearance at once, where naming a brush would be right for
   one appearance and wrong for the rest.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing.xaml#L4-L5 */
.fui-Button .fui-Spinner__spinner.fui-Spinner__spinner {
  --colorBrandStroke1: currentColor;
}

/* Fluent's reduce answer is undone in full. WinUI answers the preference by
   doing nothing: ProgressRing is an AnimatedVisualPlayer, so it reaches neither
   UISettings.AnimationsEnabled nor the visual-state gate that seeks a
   storyboard to its end frame, and a Windows ring keeps its full animation with
   animations off.

   Each declaration below restores the value Fluent itself states outside its
   reduce block -- 1.5s is Fluent's own base duration, not a number of ours --
   and the block is gated on screen exactly as Fluent's is, so print keeps
   whatever Fluent leaves it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing.xaml#L31-L32
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-spinner/library/src/components/Spinner/useSpinnerStyles.styles.ts#L58-L67
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-spinner/library/src/components/Spinner/useSpinnerStyles.styles.ts#L92-L120 */
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
