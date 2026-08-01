import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

// How danger is painted, in the two forms it takes.
//
// Text that reports a failure wears the colour at rest, because the colour is
// the report. A destructive action does not: it reads as destructive when the
// operator reaches for it, and resident red would shout from every row and
// break the rhythm of the list it sits in.
//
// The guard is the whole of it. Without one the warning colour also paints an
// action the operator is not allowed to press, which is the opposite of what
// it means. A `Button` says "not for you" with `:disabled`; a menu item is a
// `div`, where `:enabled` never matches at all, and says it with
// `aria-disabled` — so the rule is stated once per element kind rather than
// once in a form that silently never fires on half of its consumers.
const RED = 'var(--colorPaletteRedForeground1) !important';

const useStyles = makeStyles({
  button: {
    ':enabled:hover': { color: RED },
    ':enabled:active': { color: RED },
    ':enabled:focus': { color: RED },
    ':enabled:focus-visible': { color: RED },
  },
  menuItem: {
    '&:not([aria-disabled="true"]):hover': { color: RED },
    '&:not([aria-disabled="true"]):active': { color: RED },
    '&:not([aria-disabled="true"]):focus': { color: RED },
    '&:not([aria-disabled="true"]):focus-visible': { color: RED },
  },
});

export const useDangerActionClasses = (): ReturnType<typeof useStyles> => useStyles();

// Text that reports a failure is red, and every such report in the dashboard
// shares this one declaration. A surface that indexes red by severity name
// alongside its siblings keeps its own scale instead.
const useTextStyles = makeStyles({
  danger: { color: 'var(--colorPaletteRedForeground1)' },
});

export const useDangerTextClass = (): string => useTextStyles().danger;
