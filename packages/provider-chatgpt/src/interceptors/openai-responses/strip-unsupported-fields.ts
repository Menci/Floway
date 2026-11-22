import type { OpenAIResponsesBoundaryCtx } from './types.ts';
import { stripChatGPTUnsupportedFields } from '../../responses-fields.ts';

export const stripUnsupportedFields = async <TResult>(
  ctx: OpenAIResponsesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  ctx.payload = stripChatGPTUnsupportedFields(ctx.payload) as typeof ctx.payload;
  return await run();
};
