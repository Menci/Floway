import { ALL_PROVIDER_KINDS, type UpstreamProviderKind, type UpstreamRecord } from '@floway-dev/provider';

export const upstreamErrorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const isValidProviderKind = (value: unknown): value is UpstreamProviderKind =>
  typeof value === 'string' && (ALL_PROVIDER_KINDS as readonly string[]).includes(value);

export const nextUpstreamUpdatedAt = (current: UpstreamRecord): string => {
  const previous = Date.parse(current.updatedAt);
  if (!Number.isFinite(previous)) {
    throw new Error(`Upstream ${current.id} has an invalid updatedAt timestamp`);
  }
  return new Date(Math.max(Date.now(), previous + 1)).toISOString();
};
