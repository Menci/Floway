import type { Result } from '@floway-dev/pipeline';

// `-1` denotes an unlimited entitlement, per GitHub's SDK declaration.
// https://github.com/github/copilot-sdk/blob/6be623b01b194a61466385e3f708639ec98ce8ac/nodejs/src/generated/rpc.ts#L6598-L6600
const UNLIMITED_SENTINEL = -1;

export const resolveCopilotQuotaUnlimited = (entitlement: number, unlimited: boolean): Result<boolean, TypeError> => {
  const resolved = unlimited || entitlement === UNLIMITED_SENTINEL;
  if (entitlement < 0 && !resolved) return { ok: false, error: new TypeError('Invalid Copilot quota entitlement') };
  return { ok: true, value: resolved };
};

export const assertCanonicalCopilotQuotaUnlimited = (entitlement: number, unlimited: boolean): void => {
  const resolved = resolveCopilotQuotaUnlimited(entitlement, unlimited);
  if (!resolved.ok) throw resolved.error;
  if (resolved.value !== unlimited) throw new TypeError('Copilot quota unlimited flag is not canonical');
};
