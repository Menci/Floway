import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Badge, makeStyles } = fluentComponents;

const useStyles = makeStyles({
  root: {
    fontFamily: 'var(--fontFamilyMonospace)',
    fontSize: '13px',
    fontWeight: 'var(--fontWeightRegular)',
    justifyContent: 'center',
    minWidth: '48px',
  },
});

type HttpBadgeColor = 'brand' | 'danger' | 'informative' | 'success' | 'warning';

function HttpBadge({ children, color }: { children: ReactNode; color: HttpBadgeColor }) {
  const styles = useStyles();
  return <Badge
    appearance="tint"
    className={styles.root}
    color={color}
    size="medium"
    translate="no"
  >{children}</Badge>;
}

export function HttpMethodBadge({ method }: { method: string }) {
  return <HttpBadge color={method === 'GET' ? 'brand' : method === 'POST' ? 'success' : 'informative'}>{method}</HttpBadge>;
}

export function HttpStatusBadge({ children, color }: { children: ReactNode; color: 'danger' | 'success' | 'warning' }) {
  return <HttpBadge color={color}>{children}</HttpBadge>;
}
