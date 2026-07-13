import type { ResponsesBoundaryCtx } from './types.ts';

// ChatGPT-subscription catalog models reject missing or empty `instructions`.
// Native and translated callers may omit the field, so the provider supplies a
// neutral value at its boundary. Other values remain upstream-owned validation.
// https://github.com/im4codes/imcodes/blob/5f769d933dfd679e3a4d670183b0384a1baf62cd/src/agent/providers/codex-sdk.ts#L560-L579
export const injectDefaultInstructions = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const instructions = ctx.payload.instructions;
  if (instructions === undefined || instructions === null || instructions === '') {
    ctx.payload = { ...ctx.payload, instructions: "You're a helpful assistant." };
  }
  return await run();
};
