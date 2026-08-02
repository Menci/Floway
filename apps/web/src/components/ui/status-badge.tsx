import type { BadgeProps } from '@fluentui/react-components';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Badge } = fluentComponents;

/** Fluent's `medium` default has an empty size rule, leaving the 20px root reset box, so every dashboard badge is `large`. */
export function StatusBadge({ children, color }: {
  children: ReactNode;
  color: BadgeProps['color'];
}) {
  return <Badge appearance="tint" color={color} size="large">{children}</Badge>;
}
