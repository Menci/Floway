import type { ReactNode } from 'react';

import { StatusBadge } from './status-badge';
import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

// Monospace, but at the badge's own Caption size: the app's mono ramp shrinks a
// pixel to sit inside prose, and a badge label has none beside it. The width
// floor exceeds every method name, so a column of these reads as one width.
const useStyles = makeStyles({
  root: {
    fontFamily: 'var(--fontFamilyMonospace)',
    minWidth: '48px',
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
