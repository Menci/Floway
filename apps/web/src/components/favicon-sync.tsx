import { useEffect } from 'react';

import { mark } from './logo-mark';

// The tab wears whichever mark this load drew, so the window matches the logo
// inside it.
//
// The document declares no icon of its own: the link is made here instead,
// because which mark it points at is not known until the module above runs, and
// a `<link>` written into the prerendered index.html would name one mark for
// every load. Replacing the icon after load is what a browser honours -- Chrome
// fetches the new href both when the element is appended and when an existing
// one has its href reassigned, which is verifiable by watching the request.
//
// Safari is the one engine that has never supported an SVG `rel="icon"`. There
// it falls back to the default it would have shown anyway, since nothing else
// declares one.
export function FaviconSync() {
  useEffect(() => {
    const existing = window.document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const link = existing ?? window.document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = mark.url;
    if (existing === null) window.document.head.appendChild(link);
  }, []);

  return null;
}
