import type { ReactNode } from 'react';
import { useHref, useLinkClickHandler } from 'react-router';

import { fluentComponents } from '../../fluent';
import { pageNavigation } from '../../lib/page-navigation';

const { Link } = fluentComponents;

// A link to another dashboard route, spelled as the Fluent Link the WinUI layer
// paints rather than as a router Link the layer cannot reach. It stays a real
// anchor with an href, so a middle click still opens a tab, and defers to the
// router on a plain click the way the sidebar's items do.
//
// `children` is optional because `Trans` supplies them by cloning the element
// it was handed, so an interpolated link is authored without any.
export function RouteLink({ children, to }: { children?: ReactNode; to: string }) {
  const href = useHref(to);
  const handleClick = useLinkClickHandler<HTMLAnchorElement>(to, pageNavigation);
  return <Link href={href} onClick={handleClick}>{children}</Link>;
}
