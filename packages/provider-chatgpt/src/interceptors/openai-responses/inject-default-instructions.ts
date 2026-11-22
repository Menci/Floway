import type { OpenAIResponsesBoundaryCtx } from './types.ts';
import { chatgptModelUsesResponsesLite } from '../../models.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ProviderModel } from '@floway-dev/provider';

// Standard ChatGPT-subscription models reject missing or empty `instructions`.
// Lite models accept an empty top-level field because base instructions live
// in a tagged developer input item, when the caller supplies one.
// https://github.com/im4codes/imcodes/blob/5f769d933dfd679e3a4d670183b0384a1baf62cd/src/agent/providers/codex-sdk.ts#L560-L579
// https://github.com/openai/codex/blob/0462dcc062b822bb8fff16cc31ce6eeab69823b9/codex-rs/core/src/client.rs#L902-L938
export const defaultChatGPTInstructions = <P extends Omit<CanonicalOpenAIResponsesPayload, 'model'>>(
  payload: P,
  model: Pick<ProviderModel, 'id' | 'providerData'>,
): P => {
  const instructions = payload.instructions;
  return !chatgptModelUsesResponsesLite(model) && (instructions === undefined || instructions === null || instructions === '')
    ? { ...payload, instructions: "You're a helpful assistant." }
    : payload;
};

export const injectDefaultInstructions = async <TResult>(
  ctx: OpenAIResponsesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  ctx.payload = defaultChatGPTInstructions(ctx.payload, ctx.model);
  return await run();
};
