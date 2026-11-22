import { chatgptModelUsesResponsesLite } from './models.ts';
import { defineStage, transform } from '@floway-dev/pipeline';
import type { ProviderResponsesInput, ProviderResponsesOutput, ProviderServices } from '@floway-dev/provider';

// Standard ChatGPT-subscription models reject missing or empty `instructions`.
// Lite models accept an empty top-level field because base instructions live
// in a tagged developer input item, when the caller supplies one.
// https://github.com/im4codes/imcodes/blob/5f769d933dfd679e3a4d670183b0384a1baf62cd/src/agent/providers/codex-sdk.ts#L560-L579
// https://github.com/openai/codex/blob/0462dcc062b822bb8fff16cc31ce6eeab69823b9/codex-rs/core/src/client.rs#L902-L938
export const injectDefaultInstructions = defineStage<ProviderResponsesInput, ProviderResponsesInput, ProviderResponsesOutput, ProviderResponsesOutput, ProviderServices>({
  name: 'chatgpt.responses.inject-default-instructions',
  through: {
    request: { needs: ['request.payload', 'provider.model'], consumes: [], provides: ['request.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const payload = facts['request.payload'];
      const instructions = payload.instructions;
      if (chatgptModelUsesResponsesLite(facts['provider.model']) || (instructions !== undefined && instructions !== null && instructions !== '')) return facts;
      return { ...facts, 'request.payload': { ...payload, instructions: "You're a helpful assistant." } };
    },
  })),
});
