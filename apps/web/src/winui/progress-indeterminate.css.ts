// The Indeterminate visual state of WinUI 3's ProgressBar, as the pair of
// travelling indicators every surface that shows one has to draw: two
// left-aligned rectangles sized 40 and 60 per cent of the track, on one 2s loop
// that repeats forever, the second held at its start until 0.75s. Each
// indicator's travel is expressed in its own width, which is what
// UpdateWidthBasedTemplateSettings computes from those two fractions.
//
// The caller supplies the two selectors and paints them; only the geometry and
// the timing are stated here, so the one storyboard cannot drift between the
// controls that run it.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.xaml#L94-L112
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.xaml#L164-L172
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar.cpp#L208-L231
const LOOP_MS = 2000;
const FIRST_TRAVEL_MS = 1500;
const SECOND_HOLD_MS = 750;

const FIRST_WIDTH_PERCENT = 40;
const SECOND_WIDTH_PERCENT = 60;

const FIRST_START_PERCENT = -100;
const FIRST_END_PERCENT = 300;
const SECOND_START_PERCENT = -150;
const SECOND_END_PERCENT = 166;

// The KeySpline both travels share. XAML hangs a spline on the frame it
// interpolates into and CSS hangs a timing function on the frame it
// interpolates out of, so it sits one keyframe earlier here than it reads
// there.
const TRAVEL_EASING = 'cubic-bezier(0.4, 0, 0.6, 1)';

const keyTime = (ms: number) => `${(ms / LOOP_MS) * 100}%`;

export const progressIndeterminateCss = (first: string, second: string) => `
${first},
${second} {
  animation-duration: ${LOOP_MS}ms;
  animation-iteration-count: infinite;
  animation-timing-function: linear;
}

${first} {
  animation-name: winui-progress-indeterminate;
  width: ${FIRST_WIDTH_PERCENT}%;
}

${second} {
  animation-name: winui-progress-indeterminate-2;
  width: ${SECOND_WIDTH_PERCENT}%;
}

@keyframes winui-progress-indeterminate {
  0% {
    animation-timing-function: ${TRAVEL_EASING};
    transform: translateX(${FIRST_START_PERCENT}%);
  }
  ${keyTime(FIRST_TRAVEL_MS)} { transform: translateX(${FIRST_END_PERCENT}%); }
  100% { transform: translateX(${FIRST_END_PERCENT}%); }
}

@keyframes winui-progress-indeterminate-2 {
  0% { transform: translateX(${SECOND_START_PERCENT}%); }
  ${keyTime(SECOND_HOLD_MS)} {
    animation-timing-function: ${TRAVEL_EASING};
    transform: translateX(${SECOND_START_PERCENT}%);
  }
  100% { transform: translateX(${SECOND_END_PERCENT}%); }
}
`;
