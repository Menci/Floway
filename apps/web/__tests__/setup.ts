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
