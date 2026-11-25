import type { OpenAIResponsesBoundaryCtx } from './types.ts';
import { withChatGPTDefaultInstructions } from '../../responses-payload.ts';
export const injectDefaultInstructions = async <TResult>(
  ctx: OpenAIResponsesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  ctx.payload = withChatGPTDefaultInstructions(ctx.payload, ctx.model);
  return await run();
};
