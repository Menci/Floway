import { fluentComponents } from '../../fluent';

const { buttonClassNames, makeStyles } = fluentComponents;

// WinUI's SystemFillColorCritical, the same brush the validation message and
// the error message bar read.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L282
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L78
//
// Important because the WinUI layer states the foreground of a chromeless
// button and of a menu item on doubled class names, which a single Griffel
// class does not outrank.
const RED = 'var(--winui-system-fill-critical) !important';

// Without this the declarations above outrank Fluent's forced-colours pairing
// of a reached surface with Highlight, dropping the Highlight step on a menu
// item and landing red on the system hover fill of a button.
const FORCED = 'Highlight !important';

// A Fluent Button paints its icon slot from a descendant rule of its own, so a
// colour on the root reaches the label and leaves the glyph. A menu item needs
// no counterpart: ../../winui/controls/menu.css.ts already hands its icon the
// item's own colour.
const ICON = `& .${buttonClassNames.icon}`;

// A Button carries `:disabled` when disabled and `aria-disabled` when disabled
// and still focusable; a menu item, being a `div`, carries only `aria-disabled`.
const ENABLED = '&:not(:disabled):not([aria-disabled="true"])';
const HOVER = `${ENABLED}:hover`;
const PRESSED = `${ENABLED}:active`;
// Not `:focus`, which a click also sets, leaving the colour resident after the
// pointer has moved on.
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

const useTextStyles = makeStyles({
  danger: { color: 'var(--winui-system-fill-critical)' },
});

export const useDangerTextClass = (): string => useTextStyles().danger;
