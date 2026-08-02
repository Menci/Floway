import type { BadgeProps } from '@fluentui/react-components';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Badge } = fluentComponents;

/**
 * `large` is the size every badge in the dashboard is: a 24px box around a 12px
 * label. Fluent's `medium` default has an empty size rule and so leaves the 20px
 * box its root reset states.
 */
export function StatusBadge({ children, className, color }: {
  children: ReactNode;
  className?: string;
  color: BadgeProps['color'];
}) {
  return <Badge appearance="tint" className={className} color={color} size="large">{children}</Badge>;
}
