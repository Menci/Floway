import { FAST_SERVICE_TIER, isFastServiceTier } from '@floway-dev/protocols/common';

// Gemini's ServiceTier enum spells the accelerated lane as `priority` and the standard lane as `standard`.
// https://ai.google.dev/api/generate-content#ServiceTier

export const geminiServiceTierToInputIR = (tier: string | undefined): string | undefined => {
  if (tier === undefined || tier === '') return undefined;
  return tier === 'standard' ? 'default' : tier;
};

export const geminiServiceTierFromInputIR = (tier: string | null | undefined): string | undefined => {
  // Omit `auto` since Gemini has no matching tier value.
  if (tier == null || tier === '' || tier === 'auto') return undefined;
  if (isFastServiceTier(tier)) return FAST_SERVICE_TIER;
  return tier === 'default' ? 'standard' : tier;
};

export const geminiServiceTierToOutputIR = (tier: string | undefined): string | undefined => {
  if (tier === undefined || tier === '') return undefined;
  if (tier === FAST_SERVICE_TIER) return 'fast';
  return tier === 'standard' ? 'default' : tier;
};

export const geminiServiceTierFromOutputIR = (tier: string | undefined): string | undefined => {
  if (tier === undefined || tier === '') return undefined;
  if (tier === 'fast') return FAST_SERVICE_TIER;
  return tier === 'default' ? 'standard' : tier;
};
