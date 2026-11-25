import { chatgptModelUsesResponsesLite } from '../../models.ts';
import { chatgptFactSpace } from '../facts.ts';
import { transform } from '@floway-dev/pipeline';
import type { ProviderModelFact } from '@floway-dev/provider';

const { defineStage } = chatgptFactSpace;

// Standard ChatGPT-subscription models reject missing or empty `instructions`.
// Lite models accept an empty top-level field because base instructions live
// in a tagged developer input item, when the caller supplies one.
// https://github.com/im4codes/imcodes/blob/5f769d933dfd679e3a4d670183b0384a1baf62cd/src/agent/providers/codex-sdk.ts#L560-L579
// https://github.com/openai/codex/blob/0462dcc062b822bb8fff16cc31ce6eeab69823b9/codex-rs/core/src/client.rs#L902-L938
const withDefault = <Payload extends { instructions?: string | null }>(payload: Payload, model: ProviderModelFact) => {
  const { instructions } = payload;
  return chatgptModelUsesResponsesLite(model) || (instructions !== undefined && instructions !== null && instructions !== '')
    ? payload
    : { ...payload, instructions: "You're a helpful assistant." };
};

const unchanged = { needs: [], provides: [], consumes: [] } as const;

export const injectOpenAIResponsesDefaultInstructions = defineStage({
  name: 'chatgpt.openaiResponses.inject-default-instructions',
  through: {
    request: { needs: ['provider.model', 'request.openaiResponses'], provides: ['request.openaiResponses'], consumes: [] },
    response: unchanged,
  },
  execute: transform(() => ({
    request: facts => ({ ...facts, 'request.openaiResponses': withDefault(facts['request.openaiResponses'], facts['provider.model']) }),
  })),
});

export const injectOpenAIResponsesCompactDefaultInstructions = defineStage({
  name: 'chatgpt.openaiResponsesCompact.inject-default-instructions',
  through: {
    request: { needs: ['provider.model', 'request.openaiResponsesCompact'], provides: ['request.openaiResponsesCompact'], consumes: [] },
    response: unchanged,
  },
  execute: transform(() => ({
    request: facts => ({ ...facts, 'request.openaiResponsesCompact': withDefault(facts['request.openaiResponsesCompact'], facts['provider.model']) }),
  })),
});
