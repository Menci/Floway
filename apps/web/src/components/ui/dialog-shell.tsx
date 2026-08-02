import type { DialogProps } from '@fluentui/react-components';
import type { CSSProperties, ReactNode } from 'react';

import { ScrollArea } from './scroll-area';
import { fluentComponents } from '../../fluent';

const { Dialog, DialogBody, DialogContent, DialogSurface, mergeClasses } = fluentComponents;

// Fluent can only animate a dialog out while the surface is still mounted, so
// `open` is a prop: a shell hard-coded to `open` and closed by unmounting leaves
// the exit no frames to run in.
export function DialogShell({ actions, children, maxWidth, onExited, onOpenChange, onSubmit, open, surfaceClassName, title }: {
  actions: ReactNode;
  children: ReactNode;
  /** Overrides ContentDialogMaxWidth. */
  maxWidth?: string;
  /**
   * Runs once the surface has finished animating out. A caller whose
   * confirmation destroys the tree the dialog lives in does the deed here:
   * closing and destroying in one handler is one React commit, and the exit
   * never gets to start.
   */
  onExited?: () => void;
  onOpenChange: DialogProps['onOpenChange'];
  onSubmit?: () => void;
  open: boolean;
  surfaceClassName?: string;
  title: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      surfaceMotion={{ onMotionFinish: (_, data) => { if (data.direction === 'exit') onExited?.(); } }}
    >
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
            <DialogContent className="floway-dialog-shell__content">
              <ScrollArea axes="vertical" className="floway-dialog-shell__scroller h-full min-h-0" contentClassName="grid gap-4" viewportClassName="floway-dialog-shell__scrollport">
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
