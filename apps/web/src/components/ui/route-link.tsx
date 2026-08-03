import type { MouseEvent, ReactNode } from 'react';
import { useHref, useLinkClickHandler } from 'react-router';

import { fluentComponents } from '../../fluent';
import { pageNavigation } from '../../lib/page-navigation';

const { Link } = fluentComponents;

export interface RouteAddress {
  href: string;
  onClick: (event: MouseEvent<HTMLElement>) => void;
}

// The address a control carries so that every click the browser handles itself
// -- middle, modified, and "open in new tab" from the context menu -- lands on
// a real anchor and opens a second tab. Only the plain left click is taken
// here, which is what keeps a control's behaviour the one it already had.
//
// `onActivate` is for a surface that owns its own transition, holding the view
// in state and writing the URL after it; the address then only has to say where
// that view lives. Without it the plain click is the router's, and a page change
// carries the mark ../../lib/page-navigation.ts describes.
export function useRouteAddress(to: string, onActivate?: () => void): RouteAddress {
  const href = useHref(to);
  const routerClick = useLinkClickHandler<HTMLElement>(to, pageNavigation);
  return {
    href,
    onClick: event => {
      if (onActivate === undefined) {
        routerClick(event);
        return;
      }
      // The test `useLinkClickHandler` applies before it takes a click of its
      // own: every other click belongs to the browser.
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      onActivate();
    },
  };
}

// A link to another dashboard route, spelled as the Fluent Link the WinUI layer
// paints rather than as a router Link the layer cannot reach.
//
// `children` is optional because `Trans` supplies them by cloning the element
// it was handed, so an interpolated link is authored without any.
export function RouteLink({ children, to }: { children?: ReactNode; to: string }) {
  const address = useRouteAddress(to);
  return <Link {...address}>{children}</Link>;
}
