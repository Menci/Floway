import { chatgptModelUsesResponsesLite } from './models.ts';
import type { ProviderModel } from '@floway-dev/provider';

// Standard ChatGPT-subscription models require instructions. Lite models can
// instead carry base instructions in a tagged developer input item.
// https://github.com/im4codes/imcodes/blob/5f769d933dfd679e3a4d670183b0384a1baf62cd/src/agent/providers/codex-sdk.ts#L560-L579
// https://github.com/openai/codex/blob/0462dcc062b822bb8fff16cc31ce6eeab69823b9/codex-rs/core/src/client.rs#L902-L938
export const withChatGPTDefaultInstructions = <Payload extends { instructions?: string | null }>(
  payload: Payload, model: Pick<ProviderModel, 'id' | 'providerData'>,
): Payload => {
  const { instructions } = payload;
  return !chatgptModelUsesResponsesLite(model) && (instructions === undefined || instructions === null || instructions === '')
    ? { ...payload, instructions: "You're a helpful assistant." }
    : payload;
};

// These fields belong to the public API rather than Codex's request shape.
// https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/client.rs#L651-L678
export const withoutChatGPTUnsupportedFields = <Payload extends object>(payload: Payload): Payload => {
  const {
    max_output_tokens: _maxOutputTokens,
    temperature: _temperature,
    top_p: _topP,
    frequency_penalty: _frequencyPenalty,
    presence_penalty: _presencePenalty,
    user: _user,
    metadata: _metadata,
    prompt_cache_retention: _promptCacheRetention,
    safety_identifier: _safetyIdentifier,
    stream_options: _streamOptions,
    ...remaining
  } = payload as Payload & Record<string, unknown>;
  return remaining as Payload;
};
