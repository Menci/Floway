import type { AnthropicMessagesBoundaryCtx } from './types.ts';
import { addDefaultTemplate } from '../../pipelines/anthropic-messages/inject-default-template.ts';

export const injectDefaultTemplate = async <TResult>(
  ctx: AnthropicMessagesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  ctx.payload = addDefaultTemplate(ctx.payload);
  return await run();
};
