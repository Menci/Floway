// ProgressBar restyled as WinUI 3's ProgressBar and Spinner as its ProgressRing.
//
// Colour is handed over as a token remap, never as a painted slot: Fluent
// reserves the bar's own `background-color` for its error, warning and success
// variants and the ring's for `appearance="inverted"`, each one atom deep, so a
// rule painting the slot would outrank the very signal it is meant to carry.
//
// Motion is left to Fluent for the ring; the bar's indeterminate storyboard is
// transcribed here, since Fluent's own is a Web Animations API animation of a
// shape WinUI does not have.
import { progressIndeterminateCss } from '../progress-indeterminate.css';

export const progressCss = `
/* WinUI states the control's 3 minimum height and its track's 1 separately, so
   the track is a centred hairline band inside a box the indicator fills, and
   the transparent background-color is what cancels Fluent's full-height fill.
   ProgressBarMinHeight is a floor, so Fluent's 2px medium rises to it and its
   4px large is left alone. ProgressBarCornerRadius is 1.5 and is written as the
   length it is, so the corner holds at every thickness and whatever shape a
   caller asks for.
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
   the DOM through ARIA rather than a class, because Fluent writes
   aria-valuenow only when a value exists and its absence is what indeterminate
   means.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.xaml#L94-L99 */
.fui-ProgressBar.fui-ProgressBar:not([aria-valuenow]) {
  background-image: none;
  position: relative;
}

/* The two travelling indicators. Fluent renders one segment, so the second is
   a pseudo element on the root, painted ProgressBarForeground like the first --
   AccentFillColorDefaultBrush in either theme dictionary, which is where the
   bar arrives through the token remap below. The cap Fluent puts on the
   segment is released in both its forms, 33 per cent and the 100 per cent it
   becomes under a reduced-motion preference: the widths belong to the
   storyboard, and WinUI states no quieter variant of it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.xaml#L164-L172
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L6 */
.fui-ProgressBar:not([aria-valuenow]) .fui-ProgressBar__bar.fui-ProgressBar__bar {
  max-width: none;
}

.fui-ProgressBar.fui-ProgressBar:not([aria-valuenow])::after {
  background-color: var(--winui-accent-fill-default);
  border-radius: inherit;
  content: '';
  inset: 0 auto 0 0;
  position: absolute;
}
${progressIndeterminateCss(
  '.fui-ProgressBar:not([aria-valuenow]) .fui-ProgressBar__bar.fui-ProgressBar__bar',
  '.fui-ProgressBar.fui-ProgressBar:not([aria-valuenow])::after',
)}

/* High contrast. The band is dropped too, because a forced-colors palette
   repaints background colours but not gradients and ours would otherwise
   survive as our own stroke colour over the system track. content-box keeps the
   3px floor as the track's own height against the app's global border-box. A
   media query adds no specificity, so each declaration is restated at the same
   weight as the rule above it. The second indicator has to name Highlight
   itself, the colour HighContrast gives ProgressBarForeground and the one
   Fluent's own forced-colors rule hands the first.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L12-L18 */
@media (forced-colors: active) {
  .fui-ProgressBar.fui-ProgressBar {
    background-color: Canvas;
    background-image: none;
    border: 1px solid CanvasText;
    box-sizing: content-box;
  }

  .fui-ProgressBar.fui-ProgressBar:not([aria-valuenow])::after {
    background-color: Highlight;
  }
}

/* WinUI paints an errored indicator SystemFillColorCritical and a paused one
   SystemFillColorCaution, the states Fluent spells error and warning. WinUI has
   no third status, so success is pointed at SystemFillColorSuccess for
   agreement with the message a Field prints beside it. The indeterminate
   segment is repainted outright: Fluent fades it into its full-height track
   from both ends, and WinUI has no such track to fade into.
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

/* WinUI's ring is 32 square, stroked at 4, and states no other size. Fluent
   carries the width into a radial-gradient stop, where a percentage resolves
   against the closest-side radius, so a stroke of an eighth of the diameter is
   written as a quarter of the radius: WinUI's 4 at Fluent's 32px medium, and
   the same weight on the sizes Fluent offers beyond it. Forced colours are left
   to Fluent, because WinUI's high-contrast pair names
   SystemControlBackgroundBaseLowBrush, a framework alias no dictionary in
   microsoft-ui-xaml gives a high-contrast value for.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L5-L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L12-L14
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-spinner/library/src/components/Spinner/useSpinnerStyles.styles.ts#L44-L56 */

/* Two track colours are dissolved rather than one: WinUI has a single
   appearance and gives its ring ControlFillColorTransparentBrush in the light
   and the dark dictionary alike, so the ring Fluent draws behind the arc for
   appearance=inverted is as absent from WinUI as the default one. That variant
   writes its own colour in a second token instead of overriding the first, so
   it is emptied where it is written; the alpha stroke is a track colour only
   here, since the tail inside this element paints from currentcolor.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L10
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-spinner/library/src/components/Spinner/useSpinnerStyles.styles.ts#L123-L126 */
.fui-Spinner__spinner.fui-Spinner__spinner {
  --colorBrandStroke2Contrast: var(--winui-control-fill-transparent);
  --colorNeutralStrokeAlpha2: var(--winui-control-fill-transparent);
  --fui-Spinner--strokeWidth: 25%;
}

/* WinUI states the ring's Foreground as a Style setter -- an
   instance-overridable default -- and currentColor is that override written
   once for every appearance at once, where naming a brush would be right for
   one appearance and wrong for the rest.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing.xaml#L4-L5 */
.fui-Button .fui-Spinner__spinner.fui-Spinner__spinner {
  --colorBrandStroke1: currentColor;
}

/* WinUI's ProgressRing has no label part at all, so its label takes the app's
   body ramp at every Spinner size rather than the subtitle2 Fluent hands the
   medium and larger ones, which would read as a heading of the region being
   waited on. WinUI's ramp has no 16px step for that subtitle to land on either.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing.xaml#L16-L34
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L4
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L23-L25 */
.fui-Spinner__label.fui-Spinner__label {
  font-size: var(--fontSizeBase300);
  font-weight: var(--fontWeightRegular);
  line-height: var(--lineHeightBase300);
}

/* Fluent's reduce answer is undone in full, because WinUI answers the
   preference by doing nothing: ProgressRing is an AnimatedVisualPlayer, so it
   reaches neither UISettings.AnimationsEnabled nor the visual-state gate that
   seeks a storyboard to its end frame, and a Windows ring keeps its full
   animation with animations off. Each declaration restores the value Fluent
   itself states outside its reduce block -- 1.5s is Fluent's own base duration,
   not a number of ours -- and the block is gated on screen exactly as Fluent's
   is, so print keeps whatever Fluent leaves it.
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
