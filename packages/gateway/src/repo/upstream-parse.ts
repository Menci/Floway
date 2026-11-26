// Row-hydration helpers for the `upstreams` table. Centralised so a
// poisoned upstream row surfaces the same diagnostic on every read path —
// error attribution and validation policy stay uniform across SELECT
// shapes.

import type { UpstreamKind } from '@floway-dev/upstream';
import { assertUpstreamKind, normalizeUpstreamHue } from '@floway-dev/upstream';

export const parseUpstreamKind = (id: string, value: string | null): UpstreamKind => {
  try {
    return assertUpstreamKind(value ?? '');
  } catch (cause) {
    throw new Error(`Invalid upstream kind for ${id}`, { cause });
  }
};

export const parseUpstreamHue = (id: string, value: unknown): number => {
  try {
    return normalizeUpstreamHue(value);
  } catch (cause) {
    throw new Error(`Invalid upstream hue for ${id}`, { cause });
  }
};
