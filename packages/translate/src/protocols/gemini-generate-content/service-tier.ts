import { FAST_SERVICE_TIER, isFastServiceTier } from '@floway-dev/protocols/common';

// GenerateContent's ServiceTier enum spells the accelerated lane as `priority` and the standard lane as `standard`.
// https://ai.google.dev/api/generate-content#ServiceTier

export const generateContentServiceTierToIR = (tier: string | undefined): string | undefined => {
  if (tier === undefined || tier === '') return undefined;
  return tier === 'standard' ? 'default' : tier;
};

export const generateContentServiceTierFromIR = (tier: string | null | undefined): string | undefined => {
  if (tier == null || tier === '') return undefined;
  if (isFastServiceTier(tier)) return FAST_SERVICE_TIER;
  return tier === 'default' ? 'standard' : tier;
};
