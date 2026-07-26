import { ALL_PROVIDER_KINDS, type UpstreamProviderKind } from '@floway-dev/provider';

export const upstreamErrorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const isValidProviderKind = (value: unknown): value is UpstreamProviderKind =>
  typeof value === 'string' && (ALL_PROVIDER_KINDS as readonly string[]).includes(value);
