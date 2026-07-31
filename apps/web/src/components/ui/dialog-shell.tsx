import type { DialogProps } from '@fluentui/react-components';
import type { CSSProperties, ReactNode } from 'react';

import { ScrollArea } from './scroll-area';
import { fluentComponents } from '../../fluent';

const { Dialog, DialogBody, DialogContent, DialogSurface, mergeClasses } = fluentComponents;

interface DialogShellProps {
  open: boolean;
  /** Overrides ContentDialogMaxWidth for a dialog whose content needs the room. */
  maxWidth?: string;
  onOpenChange: DialogProps['onOpenChange'];
  title: ReactNode;
  actions: ReactNode;
  onSubmit?: () => void;
  children: ReactNode;
  surfaceClassName?: string;
}

// `open` is a prop rather than a constant because Fluent animates a dialog out
// of the page, and it can only do that while the surface is still mounted. A
// shell hard-coded to `open` is closed by being unmounted, which removes the
// surface in the same commit and leaves the exit no frames to run in.
export function DialogShell({ open, onOpenChange, title, actions, onSubmit, children, maxWidth, surfaceClassName }: DialogShellProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogSurface
        className={mergeClasses('floway-dialog-shell !m-auto', surfaceClassName)}
        style={maxWidth === undefined ? undefined : { '--floway-dialog-max-width': `min(${maxWidth}, calc(100vw - 32px))` } as CSSProperties}
      >
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
