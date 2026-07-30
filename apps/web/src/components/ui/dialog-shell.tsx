import type { DialogProps } from '@fluentui/react-components';
import type { ReactNode } from 'react';

import { ScrollArea } from './scroll-area';
import { fluentComponents } from '../../fluent';

const { Dialog, DialogBody, DialogContent, DialogSurface } = fluentComponents;

interface DialogShellProps {
  open?: boolean;
  onOpenChange: DialogProps['onOpenChange'];
  title: ReactNode;
  actions: ReactNode;
  onSubmit?: () => void;
  children: ReactNode;
  surfaceClassName?: string;
}

export function DialogShell({ open = true, onOpenChange, title, actions, onSubmit, children, surfaceClassName }: DialogShellProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogSurface className={`floway-dialog-shell !m-auto max-w-[min(760px,calc(100vw-32px))] ${surfaceClassName ?? ''}`}>
        <form
          className="floway-dialog-shell__form"
          onSubmit={e => {
            e.preventDefault();
            onSubmit?.();
          }}
        >
          <DialogBody className="floway-dialog-shell__body">
            {title}
            <DialogContent className="floway-dialog-shell__content !p-0">
              <ScrollArea axes="vertical" className="floway-dialog-shell__scroller h-full min-h-0" contentClassName="grid gap-4 pr-[2px]">
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
