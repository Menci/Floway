import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// The dashboard's own i18n instance, initialized once for the whole run so
// that a suite querying by accessible name resolves the same strings the app
// renders.
import '../src/i18n';

// Vitest runs without `globals`, so React Testing Library's automatic cleanup
// never arms itself. Unmounting here rather than per suite is what keeps one
// suite's DOM out of the next one's queries.
afterEach(cleanup);

// happy-dom ships no `FontFaceSet`, while every engine the dashboard runs in
// has one, so components that re-measure text once the page's fonts have
// arrived read `document.fonts` unguarded. Installing an already-settled `ready`
// for the whole run — rather than per suite — means the measurement lands in
// the same act as the mount wherever such a component is rendered.
Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { ready: Promise.resolve() },
});

// Node's own `localStorage` global shadows the one the DOM environment
// installs, and it is inert unless the runtime was started with a store to back
// it, so `getItem` is simply absent. Anything that reads the stored session
// token then throws, which reaches a suite as a component rendering an error
// instead of the request it was asked to make. The environment's own
// implementation is left alone wherever it works.
if (typeof window.localStorage?.getItem !== 'function') {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() { return store.size; },
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      key: (index: number) => [...store.keys()][index] ?? null,
      removeItem: (key: string) => { store.delete(key); },
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
    },
  });
}
