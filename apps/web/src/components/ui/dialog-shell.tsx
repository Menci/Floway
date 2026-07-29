import type { DialogProps } from '@fluentui/react-components';
import type { ReactNode } from 'react';

import { ScrollArea } from './scroll-area';
import { fluentComponents } from '../../fluent';

const { Dialog, DialogBody, DialogContent, DialogSurface } = fluentComponents;

interface DialogShellProps {
  open: boolean;
  onOpenChange: DialogProps['onOpenChange'];
  title: ReactNode;
  actions: ReactNode;
  onSubmit?: () => void;
  children: ReactNode;
  surfaceClassName?: string;
}

export function DialogShell({ open, onOpenChange, title, actions, onSubmit, children, surfaceClassName }: DialogShellProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogSurface className={`!m-auto max-w-[min(760px,calc(100vw-32px))] max-h-[calc(100vh-32px)] ${surfaceClassName ?? ''}`}>
        <form
          onSubmit={e => {
            e.preventDefault();
            onSubmit?.();
          }}
        >
          <DialogBody>
            {title}
            <DialogContent className="max-h-[calc(100vh-190px)] overflow-hidden !p-0">
              <ScrollArea axes="vertical" className="max-h-[calc(100vh-190px)]" contentClassName="grid gap-4 pr-[2px]">
                {children}
              </ScrollArea>
            </DialogContent>
            {actions}
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
