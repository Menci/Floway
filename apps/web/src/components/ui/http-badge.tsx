import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Badge, makeStyles } = fluentComponents;

// A method or a status is a badge like any other here, so it takes the size the
// upstream and model chips take: a 24px pill carrying the 12px-on-16px Caption
// that Badge's own reset states and that the WinUI layer runs at the regular
// weight. What is ours is the face and the width floor; the pill's fill, stroke
// and label colour are the tint appearance's, in both schemes.
//
// The label is a wire token, so it is set in the monospace stack. It keeps the
// badge's Caption size rather than stepping onto the app's mono ramp: that
// ramp's one-pixel reduction is spent against the prose a code span sits
// inside, and a badge label has no prose beside it.
//
// The floor is wider than any method an endpoint table lists, so the column
// they sit in reads as one width rather than one width per method name.
const useStyles = makeStyles({
  root: {
    fontFamily: 'var(--fontFamilyMonospace)',
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
