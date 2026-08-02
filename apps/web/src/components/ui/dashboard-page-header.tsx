import type { ReactNode } from 'react';

import { HEADER_ROW_CLASS } from './layout';
import { fluentComponents } from '../../fluent';

const { Text, mergeClasses } = fluentComponents;

export function DashboardPageHeader({ actions, className, description, title }: {
  actions?: ReactNode;
  className?: string;
  description?: string;
  title: string;
}) {
  return <header className={mergeClasses(HEADER_ROW_CLASS, 'gap-[18px]', className)}>
    <div className="grid gap-1.5 min-w-0">
      <Text as="h1" size={700} weight="semibold" className="m-0">
        {title}
      </Text>
      {description !== undefined && <Text size={200} className="text-fui-fg2 max-w-[760px]">
        {description}
      </Text>}
    </div>
    {actions !== undefined && <div className="flex items-center gap-2 flex-none max-[900px]:justify-start">
      {actions}
    </div>}
  </header>;
}
