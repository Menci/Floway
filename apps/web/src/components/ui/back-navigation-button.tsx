import { ArrowLeftRegular } from '@fluentui/react-icons';
import type { MouseEvent, ReactNode } from 'react';

import { useRouteAddress } from './route-link';
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

// `to` is for the back that leaves the page rather than the one that steps back
// within it: an anchor there is what a middle click can open, and Fluent's
// anchor root keeps Enter and Space through react-aria's button props.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-aria/library/src/button/useARIAButtonProps.ts#L84-L120
export function BackNavigationButton(props: { children: ReactNode } & (
  | { onClick: () => void; to?: never }
  | { onClick?: never; to: string }
)) {
  return props.to === undefined
    ? <BackButton>{props.children}</BackButton>
    : <AddressedBackButton to={props.to}>{props.children}</AddressedBackButton>;
}

function AddressedBackButton({ children, to }: { children: ReactNode; to: string }) {
  const address = useRouteAddress(to);
  return <BackButton {...address}>{children}</BackButton>;
}

function BackButton({ children, href, onClick }: { children: ReactNode; href?: string; onClick?: (event: MouseEvent<HTMLElement>) => void }) {
  const styles = useStyles();
  const shared = { appearance: 'subtle', className: styles.root, icon: <ArrowLeftRegular />, onClick } as const;
  return href === undefined
    ? <Button {...shared}>{children}</Button>
    : <Button {...shared} as="a" href={href}>{children}</Button>;
}
