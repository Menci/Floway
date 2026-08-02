import type { DialogProps } from '@fluentui/react-components';
import type { CSSProperties, ReactNode } from 'react';

import { ScrollArea } from './scroll-area';
import { fluentComponents } from '../../fluent';

const { Dialog, DialogBody, DialogContent, DialogSurface, mergeClasses } = fluentComponents;

// `open` is a prop rather than a constant because Fluent animates a dialog out
// of the page, and it can only do that while the surface is still mounted. A
// shell hard-coded to `open` is closed by being unmounted, which removes the
// surface in the same commit and leaves the exit no frames to run in.
export function DialogShell({ actions, children, maxWidth, onExited, onOpenChange, onSubmit, open, surfaceClassName, title }: {
  actions: ReactNode;
  children: ReactNode;
  /** Overrides ContentDialogMaxWidth for a dialog whose content needs the room. */
  maxWidth?: string;
  /**
   * Runs once the surface has finished animating out. A caller whose
   * confirmation destroys the tree the dialog lives in -- a sign-out, a held
   * navigation released -- does the deed here rather than on confirm: closing
   * and destroying in one handler is one React commit, and the exit never gets
   * to start.
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
            <DialogContent className="floway-dialog-shell__content !p-0">
              {/* Three boxes clip on the identical rect here -- the scrollport,
                  its host and DialogContent itself -- and a full-width control
                  inside them reaches 3px past its own border box for the
                  outline and the band it stands off by. The gutter goes on the
                  scrollport because that is the innermost of the three and the
                  only one inside the clip; the other two then have nothing left
                  to cut. It is not pulled back out with a negative margin: the
                  host already spans DialogContent exactly, so a negative margin
                  would push the content under DialogContent's own clip and put
                  the severed pixels back. */}
              <ScrollArea axes="vertical" className="floway-dialog-shell__scroller h-full min-h-0" contentClassName="grid gap-4" viewportClassName="px-[3px]">
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
