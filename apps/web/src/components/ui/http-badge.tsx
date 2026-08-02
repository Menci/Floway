import type { ReactNode } from 'react';

import { StatusBadge } from './status-badge';
import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

// Monospace, but at the badge's own Caption size: the app's mono ramp shrinks a
// pixel to sit inside prose, and a badge label has none beside it. The width
// floor exceeds every method name, so a column of these reads as one width.
//
// The padding is an optical compensation, not spacing. Maple Mono's ascent and
// descent are not symmetric about its cap band, so centring the line box leaves
// the glyph 0.75px high -- measured at 2x, 14 rows of gap above the ink and 17
// below in a 24px badge. Padding on one side moves centred content by half of
// itself, so 1.5px buys the 0.75px. This is the only place the app centres Maple
// Mono in a fixed-height box; everywhere else it sets running text.
const useStyles = makeStyles({
  root: {
    fontFamily: 'var(--fontFamilyMonospace)',
    minWidth: '48px',
    paddingTop: '1.5px',
  },
});

type HttpBadgeColor = 'brand' | 'danger' | 'informative' | 'success' | 'warning';

function HttpBadge({ children, color }: { children: ReactNode; color: HttpBadgeColor }) {
  const styles = useStyles();
  return <StatusBadge className={styles.root} color={color}>
    <span translate="no">{children}</span>
  </StatusBadge>;
}

export function HttpMethodBadge({ method }: { method: string }) {
  return <HttpBadge color={method === 'GET' ? 'brand' : method === 'POST' ? 'success' : 'informative'}>{method}</HttpBadge>;
}

export function HttpStatusBadge({ children, color }: { children: ReactNode; color: 'danger' | 'success' | 'warning' }) {
  return <HttpBadge color={color}>{children}</HttpBadge>;
}
