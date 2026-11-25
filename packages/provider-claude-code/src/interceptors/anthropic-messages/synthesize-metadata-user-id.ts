import type { AnthropicMessagesBoundaryCtx } from './types.ts';
import { addMetadataUserId } from '../../pipelines/anthropic-messages/synthesize-metadata-user-id.ts';

export const synthesizeMetadataUserId = async <TResult>(
  ctx: AnthropicMessagesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  ctx.payload = addMetadataUserId(ctx.payload, ctx.upstreamId);
  return await run();
};
