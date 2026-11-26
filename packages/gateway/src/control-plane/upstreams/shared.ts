import { ALL_UPSTREAM_KINDS, type UpstreamKind } from '@floway-dev/upstream';

export const upstreamErrorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const isValidUpstreamKind = (value: unknown): value is UpstreamKind =>
  typeof value === 'string' && (ALL_UPSTREAM_KINDS as readonly string[]).includes(value);
