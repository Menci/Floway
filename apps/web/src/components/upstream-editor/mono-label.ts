import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

// A label that names a wire path -- an endpoint, a path override -- is read as
// a literal rather than as prose, so it is set in the monospace face one pixel
// under the prose size beside it: the same reduction global.css makes for
// inline code, because a monospace face at the same nominal size out-measures
// the proportional one. WinUI has no code face, so the choice is ours. The
// size is read from --floway-font-size-mono so a mono-size scope rescales it
// along with every other monospace surface.
//
// Both outlets -- Fluent's Checkbox label slot and Field's label slot --
// render a Label, and Label states the face on its root and the size on its
// per-size atom, so the override belongs on the label element rather than on a
// parent to inherit from. It is marked important because this layer states its
// control rules with doubled class selectors, which outrank a single Griffel
// atom.
//
// Nothing here is a colour, and the leading is left at Fluent's 20px so the
// label keeps the line box the Checkbox's centring margins are computed from.
// Every state -- hover, pressed, checked, indeterminate, disabled, focus and
// forced colours -- therefore stays with the control's own rules, in both
// themes. WinUI reads the same way: the check box's twelve visual states and
// the text box header's disabled state animate Foreground alone, while the
// face and the size are style setters no state touches.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L288-L289
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L301-L595
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L335
const useStyles = makeStyles({
  label: {
    fontFamily: 'var(--fontFamilyMonospace) !important',
    fontSize: 'var(--floway-font-size-mono) !important',
  },
});

export const useMonoLabelClass = (): string => useStyles().label;
