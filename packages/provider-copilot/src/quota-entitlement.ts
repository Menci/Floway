// `-1` denotes an unlimited entitlement, per GitHub's SDK declaration.
// https://github.com/github/copilot-sdk/blob/6be623b01b194a61466385e3f708639ec98ce8ac/nodejs/src/generated/rpc.ts#L6598-L6600
const UNLIMITED_SENTINEL = -1;

export const resolveCopilotQuotaUnlimited = (entitlement: number, unlimited: boolean): boolean => {
  const resolved = unlimited || entitlement === UNLIMITED_SENTINEL;
  if (entitlement < 0 && !resolved) throw new TypeError('Invalid Copilot quota entitlement');
  return resolved;
};

export const assertCanonicalCopilotQuotaUnlimited = (entitlement: number, unlimited: boolean): void => {
  if (resolveCopilotQuotaUnlimited(entitlement, unlimited) !== unlimited) throw new TypeError('Copilot quota unlimited flag is not canonical');
};
