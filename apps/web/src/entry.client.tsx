import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';

// React Router's own client entry, with one addition: a recoverable error is
// not recoverable here.
//
// React answers a hydration mismatch by discarding the server tree and building
// the client's from scratch, reporting it through this callback and carrying on.
// That recovery is silent to anyone not reading the console, and it is not
// local: rebuilding the document removes every node put there by something that
// is not React. A mismatch on one attribute of `<html>` once took out the probe
// ScrollArea measures native scrollbar width with, and since a detached element
// reports the same width for both of its boxes, the measurement read zero --
// which is what a platform with overlay scrollbars reads. OverlayScrollbars
// switched itself off across the whole app and nothing said so.
//
// Rethrowing from a task of its own makes it an uncaught error, which is the
// loudest thing available: no boundary catches it, and the page is visibly
// broken rather than quietly wrong. A browser extension that edits the HTML
// before React loads will trip this too. That is the intended trade -- an
// extension really has invalidated the tree React was handed, and a blank page
// is a truer report of that than a dashboard with a feature missing.
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
