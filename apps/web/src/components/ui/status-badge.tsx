import type { BadgeProps } from '@fluentui/react-components';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Badge } = fluentComponents;

/** A short state word — a plan, a quota, an outcome — coloured by what it says. */
export function StatusBadge({ children, className, color }: {
  children: ReactNode;
  className?: string;
  color: BadgeProps['color'];
}) {
  return <Badge appearance="tint" className={className} color={color}>{children}</Badge>;
}
