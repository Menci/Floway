import { ArrowLeftRegular } from '@fluentui/react-icons';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Button, makeStyles } = fluentComponents;

// WinUI's NavigationBackButtonNormalStyle has the same state table as
// SubtleButtonStyle, which the layer restyles Fluent's `subtle` appearance onto
// -- Fluent's `transparent` carries no fill in any state and so cannot state
// the two subtle fills.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationBackButton.xaml#L4-L5
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationBackButton.xaml#L23-L48
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationBackButton_themeresources.xaml#L5-L8
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L63-L68
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L129-L134

// A WinUI back button takes one brush for glyph and label in every state, where
// Fluent's subtle appearance tints the icon slot toward the brand and leaves
// the label behind, so the glyph is put back on the text fills the label takes.
// The two tokens that slot reads are redefined rather than the slot restated:
// only that slot reads them, a redefinition needs no selector strong enough to
// outrank Fluent's own, and the literal system colours of Fluent's
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
