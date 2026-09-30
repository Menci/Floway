import type { OpenAIResponsesBoundaryCtx } from './types.ts';

// ChatGPT-subscription catalog models reject missing or empty `instructions`.
// Native and translated callers may omit the field, so the provider supplies a
// neutral value at its boundary. Other values remain upstream-owned validation.
// https://github.com/im4codes/imcodes/blob/5f769d933dfd679e3a4d670183b0384a1baf62cd/src/agent/providers/codex-sdk.ts#L560-L579
export const defaultInstructionsPayload = <P extends Omit<OpenAIResponsesBoundaryCtx['payload'], 'model'>>(payload: P): P => {
  const instructions = payload.instructions;
  return instructions === undefined || instructions === null || instructions === ''
    ? { ...payload, instructions: "You're a helpful assistant." }
    : payload;
};

export const injectDefaultInstructions = async <TResult>(
  ctx: OpenAIResponsesBoundaryCtx,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  ctx.payload = defaultInstructionsPayload(ctx.payload);
  return await run();
};
