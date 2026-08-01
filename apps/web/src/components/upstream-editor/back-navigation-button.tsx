import { ArrowLeftRegular } from '@fluentui/react-icons';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Button, makeStyles } = fluentComponents;

// WinUI's back button is NavigationBackButtonNormalStyle: a transparent rest
// fill that takes SubtleFillColorSecondary under the pointer and
// SubtleFillColorTertiary under a press, with the label at the primary text
// fill and the secondary fill only while pressed. That is the same state table
// as SubtleButtonStyle, which the layer restyles Fluent's `subtle` appearance
// onto -- Fluent's `transparent` carries no fill in any state and so cannot
// state the two subtle fills.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationBackButton.xaml#L4-L5
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationBackButton.xaml#L23-L48
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationBackButton_themeresources.xaml#L5-L8
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L63-L68
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L129-L134

// The glyph and the label of a WinUI back button take one brush in every state:
// its glyph is the Content of the single presenter the PointerOver and Pressed
// states recolour. Fluent's subtle appearance names the icon slot separately
// and tints it toward the brand under both, where the label beside it does not
// follow, so the glyph is put back on the text fills the label takes.
//
// The two tokens the icon slot reads are redefined rather than the slot being
// restated: only that slot reads them, a redefinition needs no selector strong
// enough to outrank Fluent's own, and the literal system colours of Fluent's
// forced-colours rules stay in force.
const useStyles = makeStyles({
  root: {
    '--colorNeutralForeground2BrandHover': 'var(--winui-text-fill-primary)',
    '--colorNeutralForeground2BrandPressed': 'var(--winui-text-fill-secondary)',
  },
});

export function BackNavigationButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  const styles = useStyles();
  return <Button appearance="subtle" className={styles.root} icon={<ArrowLeftRegular />} onClick={onClick}>{children}</Button>;
}
