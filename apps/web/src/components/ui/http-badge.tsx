import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Badge, makeStyles } = fluentComponents;

// A method or a status is a badge like any other here, so it takes the size the
// upstream and model badges take: a 24px pill with a 12px label, and 11px where
// the label is monospace -- a pixel down, because a monospace face at the same
// nominal size out-measures the proportional one beside it.
//
// The floor holds a column of them to one width. GET, POST and DELETE differ by
// four characters, and a table reads down its column rather than across its row.
const useStyles = makeStyles({
  root: {
    fontFamily: 'var(--fontFamilyMonospace)',
    fontSize: '11px',
    fontWeight: 'var(--fontWeightRegular)',
    justifyContent: 'center',
    lineHeight: '16px',
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
    size="large"
    translate="no"
  >{children}</Badge>;
}

export function HttpMethodBadge({ method }: { method: string }) {
  return <HttpBadge color={method === 'GET' ? 'brand' : method === 'POST' ? 'success' : 'informative'}>{method}</HttpBadge>;
}

export function HttpStatusBadge({ children, color }: { children: ReactNode; color: 'danger' | 'success' | 'warning' }) {
  return <HttpBadge color={color}>{children}</HttpBadge>;
}
