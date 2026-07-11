// Row-hydration helpers shared between the primary SQL repo (`sql.ts`) and
// the dump-store's LEFT JOIN reader (`dump-store.ts`). Both read the same
// `upstreams` columns but from different SELECTs — sharing the parsers
// keeps the error attribution and validation policy uniform so a poisoned
// upstream row surfaces the same diagnostic on every read path.

import type { UpstreamColor, UpstreamProviderKind } from '@floway-dev/provider';
import { assertUpstreamProviderKind, normalizeUpstreamColor } from '@floway-dev/provider';

// Narrow the raw `provider` column value to the `UpstreamProviderKind`
// enum, re-throwing with the row id attributed for diagnostics.
export const parseUpstreamKind = (id: string, value: string | null): UpstreamProviderKind => {
  try {
    return assertUpstreamProviderKind(value ?? '');
  } catch (cause) {
    throw new Error(`Invalid upstream provider kind for ${id}`, { cause });
  }
};

// Parse the raw `color` column value into the domain shape, re-throwing
// with the row id attributed for diagnostics.
export const parseUpstreamColor = (id: string, value: string | null): UpstreamColor | null => {
  try {
    return normalizeUpstreamColor(value);
  } catch (cause) {
    throw new Error(`Invalid upstream color for ${id}`, { cause });
  }
};
