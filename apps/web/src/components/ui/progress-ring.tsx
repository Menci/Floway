import { fluentComponents } from '../../fluent';

const { makeStyles, mergeClasses } = fluentComponents;

// WinUI's ProgressRing in its determinate state. The arc paints
// ProgressRingForegroundThemeBrush -- AccentFillColorDefaultBrush in the light
// and the dark dictionary.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L5-L11
//
// Sizing follows the ring's own resources rather than this call site: 32 square
// stroked at 4, with 16 stated as the minimum, so the stroke is written as the
// eighth of the diameter it is and holds at whatever size a caller asks for.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing.xaml#L9-L14
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L15
const DIAMETER = 32;
const STROKE = 4;
const RADIUS = (DIAMETER - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// WinUI leaves the ring's own Background transparent in the light and the dark
// dictionary alike, so an arc alone is all it draws and the unfilled remainder
// is absent. A reading here has to say how much of an allowance is left as much
// as how much is spent, so the remainder is drawn, and it is drawn as the
// hairline the same design language gives ProgressBar: its track is one third
// of the indicator's own weight, centred in the same band.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L6
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L23
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L29-L32
const TRACK_STROKE = STROKE / 3;

// WinUI paints a critical reading SystemFillColorCritical and a cautionary one
// SystemFillColorCaution, the pair the restyled ProgressBar reads for Fluent's
// error and warning states.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L280
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L282
export type ProgressRingTone = 'accent' | 'caution' | 'critical';

const TONE_STROKE: Record<ProgressRingTone, string> = {
  accent: 'var(--winui-accent-fill-default)',
  caution: 'var(--winui-system-fill-caution)',
  critical: 'var(--winui-system-fill-critical)',
};

const useStyles = makeStyles({
  // A forced-colours palette repaints background and border colours but not an
  // SVG stroke, so each ring names its system colour itself: Highlight is what
  // HighContrast gives ProgressRingForegroundThemeBrush through
  // SystemControlHighlightAccentBrush, and the track takes CanvasText, the
  // foreground the same palette pairs with the surface behind it.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing_themeresources.xaml#L12-L13
  arc: {
    '@media (forced-colors: active)': {
      stroke: 'Highlight',
    },
  },
  track: {
    '@media (forced-colors: active)': {
      stroke: 'CanvasText',
    },
  },
});

// The value is carried by the text this ring stands beside, so the graphic is
// left out of the accessibility tree rather than duplicating it as a meter.
export function ProgressRing({ className, percent, size = 16, tone }: {
  className?: string;
  /** Clamped to the ring: past 100 the arc is closed, not wound a second time. */
  percent: number;
  size?: number;
  tone: ProgressRingTone;
}) {
  const styles = useStyles();
  const filled = Math.max(0, Math.min(100, percent)) / 100;

  return (
    <svg
      aria-hidden
      className={mergeClasses('block flex-none', className)}
      height={size}
      viewBox={`0 0 ${DIAMETER} ${DIAMETER}`}
      width={size}
    >
      <circle
        className={styles.track}
        cx={DIAMETER / 2}
        cy={DIAMETER / 2}
        fill="none"
        r={RADIUS}
        stroke="var(--winui-control-strong-stroke-default)"
        strokeWidth={TRACK_STROKE}
      />
      <circle
        className={styles.arc}
        cx={DIAMETER / 2}
        cy={DIAMETER / 2}
        fill="none"
        r={RADIUS}
        stroke={TONE_STROKE[tone]}
        strokeDasharray={`${CIRCUMFERENCE} ${CIRCUMFERENCE}`}
        strokeDashoffset={CIRCUMFERENCE * (1 - filled)}
        strokeWidth={STROKE}
        // The arc starts at twelve o'clock and closes clockwise.
        transform={`rotate(-90 ${DIAMETER / 2} ${DIAMETER / 2})`}
      />
    </svg>
  );
}
