import { Open16Regular } from '@fluentui/react-icons';
import type { ReactNode } from 'react';

export function OpenLinkLabel({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-1">{children}<Open16Regular aria-hidden className="block flex-none" /></span>;
}
