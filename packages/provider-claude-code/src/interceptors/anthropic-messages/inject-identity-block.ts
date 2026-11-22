import { IDENTITY_BLOCK } from './system-blocks.ts';
import type { AnthropicMessagesBoundaryCtx } from './types.ts';

// system[1]; relies on injectBillingBlock having materialized payload.system as an array (see ./index.ts chain order).
export const injectIdentityBlockPayload = <P extends Omit<AnthropicMessagesBoundaryCtx['payload'], 'model'>>(payload: P): P => {
  if (!Array.isArray(payload.system)) {
    throw new Error('inject-identity-block: expected system to be an array (inject-billing-block must run first)');
  }
  return { ...payload, system: [...payload.system, IDENTITY_BLOCK] };
};

export const injectIdentityBlock = async <TResult>(
  ctx: AnthropicMessagesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  ctx.payload = injectIdentityBlockPayload(ctx.payload);
  return await run();
};
