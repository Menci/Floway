import { ArrowLeftRegular } from '@fluentui/react-icons';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Button, makeStyles } = fluentComponents;

// NavigationBackButtonNormalStyle has SubtleButtonStyle's state table, which the
// layer restyles `subtle` onto; `transparent` carries no fill in any state.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationBackButton.xaml#L4-L5
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationBackButton.xaml#L23-L48
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationBackButton_themeresources.xaml#L5-L8
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L63-L68
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView_themeresources.xaml#L129-L134

// A WinUI back button takes one brush for glyph and label, where Fluent's subtle
// appearance tints the icon slot toward the brand and leaves the label behind.
// Redefining the two tokens that slot reads, rather than restating the slot, needs
// no selector outranking Fluent's own and leaves its forced-colours rules in force.
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
