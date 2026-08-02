import { fluentComponents } from '../../fluent';

const { buttonClassNames, makeStyles } = fluentComponents;

// How danger is painted, in the two forms it takes.
//
// Text that reports a failure wears the colour at rest, because the colour is
// the report. A destructive action takes it only when reached, so the colour
// does not sit on every row. Reaching is the pointer arriving, the press going
// down, and the keyboard landing -- the last of those being Fluent's
// `data-fui-focus-visible` rather than `:focus`, which a click also sets and
// which would leave the colour resident on a row already finished with.
//
// The brush is WinUI's SystemFillColorCritical, which a field's validation
// message and the error message bar already read, so one red carries "wrong, or
// destructive" across the dashboard instead of Fluent's web red standing beside
// WinUI's.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L282
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L78
//
// Important because the WinUI layer states the foreground of a chromeless
// button and of a menu item on doubled class names, which a single Griffel
// class does not outrank.
const RED = 'var(--winui-system-fill-critical) !important';

// Left alone, the declarations above would outrank Fluent's forced-colours
// pairing of a reached surface with Highlight: on a menu item the user agent
// would substitute the forced text colour for our red and lose the Highlight
// step, and on a button, whose hover state clears forced-color-adjust, the red
// itself would land on the system's own hover fill.
const FORCED = 'Highlight !important';

// A Fluent Button paints its icon slot from a descendant rule of its own, so a
// colour on the root reaches the label and leaves the glyph -- and this class is
// worn on icon-only buttons. A menu item's icon needs no counterpart:
// ../../winui/controls/menu.css.ts already hands it the item's own colour.
const ICON = `& .${buttonClassNames.icon}`;

// Without the guard the warning colour also paints an action the operator is
// not allowed to press. Both element kinds take the same pair of negations: a
// Button carries `:disabled` when disabled and `aria-disabled` when disabled and
// still focusable, and a menu item, being a `div`, carries only `aria-disabled`.
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

// Every failure report in the dashboard shares this declaration. A surface that
// indexes red by severity name alongside its siblings keeps its own scale.
const useTextStyles = makeStyles({
  danger: { color: 'var(--winui-system-fill-critical)' },
});

export const useDangerTextClass = (): string => useTextStyles().danger;
