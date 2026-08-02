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
// `inline` is Fluent's name for a link inside running text, which is WinUI's
// Hyperlink; without it the link is WinUI's HyperlinkButton. The two differ only
// in whether they underline at rest, and the layer keys off exactly this prop.
// `children` is optional because `Trans` supplies them by cloning the element
// it was handed, so an interpolated link is authored without any.
export function RouteLink({ children, inline, to }: { children?: ReactNode; inline?: boolean; to: string }) {
  const href = useHref(to);
  const handleClick = useLinkClickHandler<HTMLAnchorElement>(to, pageNavigation);
  return <Link href={href} inline={inline} onClick={handleClick}>{children}</Link>;
}
