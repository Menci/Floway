import { IDENTITY_BLOCK } from './system-blocks.ts';
import type { MessagePayload } from './types.ts';

// system[1]; relies on injectBillingBlock having materialized payload.system as an array (see ./index.ts chain order).
export const injectIdentityBlock = (payload: MessagePayload): MessagePayload => {
  if (!Array.isArray(payload.system)) throw new Error('inject-identity-block: expected the billing block array');
  return { ...payload, system: [...payload.system, IDENTITY_BLOCK] };
};
