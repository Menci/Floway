import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

// Label states the face on its root and the size on its per-size atom, so the
// override belongs on the label element, and is important because this layer
// states its control rules with doubled class selectors, which outrank a single
// Griffel atom.
//
// Leading stays at Fluent's 20px so the label keeps the line box the Checkbox's
// centring margins are computed from, and no colour is stated here: WinUI
// animates Foreground alone across a check box's visual states.
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
