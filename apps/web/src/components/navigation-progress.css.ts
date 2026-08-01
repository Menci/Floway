// The router's in-flight indicator, drawn as WinUI 3's ProgressBar held in its
// Indeterminate state.
//
// Nothing here is a Fluent element, so there is no Griffel atom to outrank and
// each rule names its own class once. The strip is aria-hidden and takes no
// pointer, and it never carries a value, so the only states it has are active
// and idle, each of those in light, in dark and in forced colours. Determinate,
// Error, Paused and their indeterminate variants are states of a control this
// one never becomes, and the track those states paint is the one thing
// Indeterminate switches off.
//
// This module is part of the inlined critical block, where the rest of that
// block spells its literals out because it has to be right on the first paint
// and ../winui/tokens.ts arrives with the linked stylesheet. The strip is the
// one surface in the block that names `--winui-*` anyway: it is shown by a
// router navigation and by nothing else, so it cannot be on screen until the
// app has hydrated, which is well past the point that stylesheet lands.
export const navigationProgressCss = `
  /* The strip spans the top edge of the viewport instead of sitting in a
     layout row, so the box is ours and only its thickness is WinUI's:
     ProgressBarMinHeight, the floor the template gives the grid its indicators
     fill. No rail is painted under them, because entering Indeterminate takes
     the track's opacity to 0. Clipping stands in for the ClipRect on the inner
     Border, which is what holds an indicator inside the control as it crosses.
     The strip belongs to the document rather than to a Fluent surface, so it
     stacks over the app's own content and under Fluent's portal layer at
     1000000, so a dialog and its scrim cover it.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L29
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.xaml#L94-L99
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.xaml#L156

     Arriving and leaving is ours: the template states no fade between showing a
     ProgressBar and hiding one, so rather than invent a number the strip takes
     the duration and the easing every WinUI control shares for a fast change.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L602-L606 */
  .floway-navigation-progress {
    height: 3px;
    inset: 0 0 auto;
    opacity: 0;
    overflow: hidden;
    pointer-events: none;
    position: fixed;
    transition: opacity var(--winui-control-fast-animation-duration)
      var(--winui-control-fast-out-slow-in-easing);
    /* Above Fluent's portal mount, which sits at 1000000 and carries every
       dialog, drawer, popover and their scrims. A route can be loading while one
       of those is open -- a dialog's own action navigates -- and the strip is
       the only report that it is. */
    z-index: 1000001;
  }

  .floway-navigation-progress[data-active='true'] { opacity: 1; }

  /* Both indicators are ProgressBarForeground, which is
     AccentFillColorDefaultBrush in either theme dictionary, so the accent step
     the tokens flip between carries the whole colour answer and no rule below
     is stated twice. ProgressBarCornerRadius is 1.5 and reaches each indicator
     as its rectangle's radius. They are left aligned and sized as fractions of
     the control -- 40% and 60% -- and each rests at the offset its storyboard
     starts from, so the pair is off the left edge whenever the strip is idle
     and the fade out has nothing standing still in it.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L6
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L22
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L31
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.cpp#L223-L230 */
  .floway-navigation-progress::before,
  .floway-navigation-progress::after {
    background-color: var(--winui-accent-fill-default);
    border-radius: 1.5px;
    content: '';
    inset: 0 auto 0 0;
    position: absolute;
  }
  .floway-navigation-progress::before {
    transform: translateX(-100%);
    width: 40%;
  }
  .floway-navigation-progress::after {
    transform: translateX(-150%);
    width: 60%;
  }

  /* The Indeterminate storyboard, transcribed whole: one 2s loop over two
     indicators, the second held at its start until 0.75s so the pair crosses
     staggered. Every offset in the source is a multiple of the indicator's own
     width, which is what lets each one be written as a percentage of the
     element rather than of the strip. XAML hangs a KeySpline on the frame it
     interpolates into and CSS hangs a timing function on the frame it
     interpolates out of, so the shared 0.4, 0, 0.6, 1 spline sits one keyframe
     earlier here than it reads there; the flat runs at either end need no
     curve, since both of their frames carry the same offset.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.xaml#L100-L111
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.cpp#L223-L230 */
  .floway-navigation-progress[data-active='true']::before {
    animation: floway-navigation-progress-indicator 2s linear infinite;
  }
  .floway-navigation-progress[data-active='true']::after {
    animation: floway-navigation-progress-indicator-2 2s linear infinite;
  }
  @keyframes floway-navigation-progress-indicator {
    0% {
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
      transform: translateX(-100%);
    }
    75% { transform: translateX(300%); }
    100% { transform: translateX(300%); }
  }
  @keyframes floway-navigation-progress-indicator-2 {
    0% { transform: translateX(-150%); }
    37.5% {
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
      transform: translateX(-150%);
    }
    100% { transform: translateX(166%); }
  }

  /* Nothing here answers a reduced-motion preference, and both halves are
     deliberate.

     The sweep is not decoration: it is the whole of what the strip reports. A
     bar that holds still says a navigation is in flight no more than an empty
     bar does, and the strip has no other way to say it -- there is no
     determinate width to fall back on, since a route load states no progress.
     WinUI agrees by construction: its indeterminate ProgressBar states one
     storyboard and no quieter variant, and ProgressBar is an
     AnimatedVisualPlayer, so it reaches neither UISettings.AnimationsEnabled
     nor the visual-state gate that seeks a storyboard to its end frame.

     The fade that brings the strip in and out is a state change reporting that
     the navigation started or finished, and it is over in 83ms.

     A reader who asked for less motion still gets a 3px strip sweeping at the
     top of the window for as long as a route is loading. That is a real cost of
     reporting the state at all, and it is the cost WinUI itself accepts.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.xaml#L100-L111 */

  /* WinUI's HighContrast dictionary answers the bar with a WindowTextColor
     border a pixel thick and a HighlightColor foreground, and that is what is
     written here. The border is the control's own: ProgressBarBorderBrush
     reaches ProgressBarRoot, the outermost Border of the template, which wraps
     the grid carrying MinHeight rather than the indicator rectangles inside
     it. The track it also names goes unpainted for the same reason it does
     above. A forced palette repaints a colour it can reach, so the accent has
     to be handed over as the system keyword WinUI itself names -- left as a
     token it would be forced to the page background and the strip would
     vanish. \`content-box\` holds the 3px against the app's global border-box
     so the border is added around the strip rather than taken out of it, which
     is the nesting ProgressBarRoot states.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L12-L18
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.xaml#L155-L157 */
  @media (forced-colors: active) {
    .floway-navigation-progress {
      border: 1px solid CanvasText;
      box-sizing: content-box;
    }
    .floway-navigation-progress::before,
    .floway-navigation-progress::after {
      background-color: Highlight;
    }
  }
`;
