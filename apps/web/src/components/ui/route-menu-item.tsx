import type { ComponentProps, ReactNode } from 'react';

import { useRouteAddress } from './route-link';
import { fluentComponents } from '../../fluent';

const { MenuItem, makeStyles } = fluentComponents;

// Fluent's MenuItem cannot be an anchor. Its hook destructures `as` out of the
// props before building the root slot, so the element type it renders is always
// the div its slot declares, and the anchor component Fluent ships instead —
// MenuItemLink — has no subText slot in its renderer, so it would drop the
// second line these items carry.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-menu/library/src/components/MenuItem/useMenuItemBase.ts#L38-L48
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-menu/library/src/components/MenuItemLink/renderMenuItemLink.tsx#L13-L21
//
// So the address is laid over the item as its own element. It resolves against
// the item, which Fluent's own reset makes a containing block, and it is out of
// flow, so it changes neither the layout nor the item's states. It is hidden
// from assistive technology and out of the tab order: what a reader and the
// keyboard get is the menuitem, unchanged, while the pointer and the context
// menu get a real link.
const useStyles = makeStyles({
  address: { inset: 0, position: 'absolute' },
});

export function RouteMenuItem({ children, icon, subText, to }: {
  children: ReactNode;
  icon?: ComponentProps<typeof MenuItem>['icon'];
  subText?: ComponentProps<typeof MenuItem>['subText'];
  to: string;
}) {
  const styles = useStyles();
  const address = useRouteAddress(to);
  return <MenuItem icon={icon} onClick={address.onClick} subText={subText}>
    {children}
    <a aria-hidden className={styles.address} href={address.href} tabIndex={-1} />
  </MenuItem>;
}
