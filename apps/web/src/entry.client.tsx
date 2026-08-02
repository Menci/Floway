import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';

// React Router's own client entry, with one addition: a recoverable error is not
// recoverable here. React answers a hydration mismatch by rebuilding the
// document from scratch and carrying on, which silently removes every node put
// there by something that is not React -- a mismatch on one `<html>` attribute
// once detached ScrollArea's scrollbar-width probe, making it read zero and
// switching OverlayScrollbars off app-wide. Rethrowing from its own task makes
// that an uncaught error no boundary catches. A browser extension that edits the
// HTML before React loads trips it too, and that is the intended trade.
startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
    {
      onRecoverableError(error) {
        setTimeout(() => {
          throw error;
        });
      },
    },
  );
});
