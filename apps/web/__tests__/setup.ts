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
