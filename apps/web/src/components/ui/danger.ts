import { fluentComponents } from '../../fluent';

const { buttonClassNames, makeStyles } = fluentComponents;

// How danger is painted, in the two forms it takes.
//
// Text that reports a failure wears the colour at rest, because the colour is
// the report. A destructive action does not: it reads as destructive when the
// operator reaches for it, and resident red would shout from every row and
// break the rhythm of the list it sits in. Reaching is the pointer arriving,
// the press going down, and the keyboard landing -- and the keyboard landing
// is Fluent's `data-fui-focus-visible`, the same signal the WinUI layer draws
// its focus rings from, rather than `:focus`, which a click also sets and
// which would leave the colour resident on a row the operator has already
// finished with.
//
// The brush is WinUI's SystemFillColorCritical, the one a field's validation
// message and the error message bar already read, so a single red carries
// "wrong, or destructive" across the dashboard instead of Fluent's web red
// standing beside WinUI's.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L282
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L78
//
// Each declaration is important because the WinUI layer states the foreground
// of a chromeless button and of a menu item on doubled class names, which a
// single Griffel class does not outrank.
const RED = 'var(--winui-system-fill-critical) !important';

// Under forced colours the palette belongs to the system, and Fluent pairs a
// reached surface with Highlight. Left alone, the declarations above would
// outrank that pairing: on a menu item the user agent would substitute the
// forced text colour for our red and the Highlight step would be lost, and on
// a button, whose hover state additionally clears forced-color-adjust, the red
// itself would land on the system's own hover fill. Both are restated here so
// the reach still reads as the system paints a reach.
const FORCED = 'Highlight !important';

// A Fluent Button paints its icon slot from a descendant rule of its own --
// brand-tinted on hover and while pressed, in useButtonStyles -- so a colour
// on the root reaches the label and leaves the glyph, and an icon-only button,
// which is the shape this class is worn in, would show none of it. A menu
// item's icon needs no counterpart: ../../winui/controls/menu.css.ts already
// hands it the item's own colour to inherit.
const ICON = `& .${buttonClassNames.icon}`;

// The guard is the whole of it. Without one the warning colour also paints an
// action the operator is not allowed to press, which is the opposite of what
// it means. Both element kinds take the same pair of negations: a Button
// carries `:disabled` when it is disabled and `aria-disabled` when it is
// disabled and still focusable, and a menu item, being a `div`, carries only
// `aria-disabled` -- so one guard closes both rather than each kind stating
// the half that never fires on the other.
const ENABLED = '&:not(:disabled):not([aria-disabled="true"])';
const HOVER = `${ENABLED}:hover`;
const PRESSED = `${ENABLED}:active`;
const KEYBOARD = `${ENABLED}[data-fui-focus-visible]`;

const buttonPaint = { color: RED, [ICON]: { color: RED } };
const buttonForcedPaint = { color: FORCED, [ICON]: { color: FORCED } };

const useStyles = makeStyles({
  button: {
    [HOVER]: buttonPaint,
    [PRESSED]: buttonPaint,
    [KEYBOARD]: buttonPaint,
    '@media (forced-colors: active)': {
      [HOVER]: buttonForcedPaint,
      [PRESSED]: buttonForcedPaint,
      [KEYBOARD]: buttonForcedPaint,
    },
  },
  menuItem: {
    [HOVER]: { color: RED },
    [PRESSED]: { color: RED },
    [KEYBOARD]: { color: RED },
    '@media (forced-colors: active)': {
      [HOVER]: { color: FORCED },
      [PRESSED]: { color: FORCED },
      [KEYBOARD]: { color: FORCED },
    },
  },
});

export const useDangerActionClasses = (): ReturnType<typeof useStyles> => useStyles();

// Text that reports a failure is red, and every such report in the dashboard
// shares this one declaration and the one critical brush above. A surface that
// indexes red by severity name alongside its siblings keeps its own scale
// instead.
const useTextStyles = makeStyles({
  danger: { color: 'var(--winui-system-fill-critical)' },
});

export const useDangerTextClass = (): string => useTextStyles().danger;
