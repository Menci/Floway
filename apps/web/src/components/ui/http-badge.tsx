import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Badge, makeStyles } = fluentComponents;

// A method or a status is a badge like any other here, so it takes the size the
// upstream and model badges take: a 24px pill with a 12px label. The label is
// monospace but stays at 12 -- the pixel a monospace face gives up elsewhere is
// given up against prose it sits inside, and a badge label has none beside it.
//
// The floor holds a column of them to one width. GET, POST and DELETE differ by
// four characters, and a table reads down its column rather than across its row.
//
// The padding is a compensation, not a spacing. Maple Mono's ascent and descent
// are not symmetric about its cap band, so centring the line box leaves the
// glyph high; half of this is how far the centred content moves down.
const useStyles = makeStyles({
  root: {
    fontFamily: 'var(--fontFamilyMonospace)',
    fontSize: '12px',
    fontWeight: 'var(--fontWeightRegular)',
    justifyContent: 'center',
    lineHeight: '16px',
    minWidth: '48px',
    paddingTop: '1.5px',
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
