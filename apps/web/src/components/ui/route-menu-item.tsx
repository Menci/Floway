import type { ComponentProps, ReactNode } from 'react';

import { useRouteAddress, type RouteAddress } from './route-link';
import { fluentComponents } from '../../fluent';

const { MenuItem, mergeClasses } = fluentComponents;

// Fluent declares MenuItem's root slot as a div, but the hook behind it reads
// `as` and hands the element to react-aria's button props, so an anchor keeps
// the menuitem role, the roving focus and both Enter and Space. Only the slot's
// element type is div-shaped, hence the cast.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-menu/library/src/components/MenuItem/useMenuItemBase.ts#L38-L48
//
// MenuItemLink is the component Fluent ships for this, and it is not usable
// here: its renderer has no subText slot, so it would drop the second line this
// menu's items carry.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-menu/library/src/components/MenuItemLink/renderMenuItemLink.tsx#L13-L21
const AnchorMenuItem = MenuItem as unknown as (
  props: Omit<ComponentProps<typeof MenuItem>, 'as' | 'onClick'> & RouteAddress & { as: 'a' },
) => ReactNode;

// The menu item that opens a page. Fluent's own styles never reset an anchor's
// underline, because its div root never needed one.
export function RouteMenuItem({ children, className, icon, subText, to }: {
  children: ReactNode;
  className?: string;
  icon?: ComponentProps<typeof MenuItem>['icon'];
  subText?: ComponentProps<typeof MenuItem>['subText'];
  to: string;
}) {
  const address = useRouteAddress(to);
  return <AnchorMenuItem
    {...address}
    as="a"
    className={mergeClasses('no-underline', className)}
    icon={icon}
    subText={subText}
  >
    {children}
  </AnchorMenuItem>;
}
