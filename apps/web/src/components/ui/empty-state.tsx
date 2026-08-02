import type { ReactNode } from 'react';

import { TIGHT_STACK_CLASS } from './layout';
import { fluentComponents } from '../../fluent';

const { Text, mergeClasses } = fluentComponents;

// Centring rather than stretching: a stretched grid item hands the slack to its
// own rows, and the title, the line under it and the action drift to opposite
// ends of the panel.
const ALIGN_CLASS = {
  center: 'text-center justify-items-center',
  start: 'justify-items-start',
} as const;

export function EmptyState({ action, align = 'center', className, description, title }: {
  action?: ReactNode;
  align?: keyof typeof ALIGN_CLASS;
  className?: string;
  description?: ReactNode;
  title: ReactNode;
}) {
  return <div className={mergeClasses('grid place-items-center min-h-[180px]', className)}>
    <div className={mergeClasses('grid gap-3 max-w-[480px]', ALIGN_CLASS[align])}>
      <div className={TIGHT_STACK_CLASS}>
        <Text size={300} weight="semibold">{title}</Text>
        {description !== undefined && <Text size={200} className="text-fui-fg2">{description}</Text>}
      </div>
      {action}
    </div>
  </div>;
}

// No inset of its own: a flush panel, a section body and a legend row each hold
// their content off their edge by a different measure.
export function EmptyStateLine({ children, className }: { children: ReactNode; className?: string }) {
  return <Text block size={300} className={mergeClasses('text-fui-fg2', className)}>{children}</Text>;
}
