import type { OpenAIResponsesBoundaryCtx } from './types.ts';
import { withoutChatGPTUnsupportedFields } from '../../responses-payload.ts';

export const stripUnsupportedFields = async <TResult>(
  ctx: OpenAIResponsesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  ctx.payload = withoutChatGPTUnsupportedFields(ctx.payload);
  return await run();
};
