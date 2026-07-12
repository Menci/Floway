// Row-hydration helpers for the `upstreams` table. Centralised so a
// poisoned upstream row surfaces the same diagnostic on every read path —
// error attribution and validation policy stay uniform across SELECT
// shapes.

import type { UpstreamColor, UpstreamProviderKind } from '@floway-dev/provider';
import { assertUpstreamProviderKind, normalizeUpstreamColor } from '@floway-dev/provider';

export const parseUpstreamKind = (id: string, value: string | null): UpstreamProviderKind => {
  try {
    return assertUpstreamProviderKind(value ?? '');
  } catch (cause) {
    throw new Error(`Invalid upstream provider kind for ${id}`, { cause });
  }
};

export const parseUpstreamColor = (id: string, value: string | null): UpstreamColor | null => {
  try {
    return normalizeUpstreamColor(value);
  } catch (cause) {
    throw new Error(`Invalid upstream color for ${id}`, { cause });
  }
};
