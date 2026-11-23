import { abortCopilotOpenAIChatCompletionsToolArgumentWhitespace } from './abort-on-tool-argument-whitespace.ts';
import { attachCopilotCacheControlMarkers } from './attach-cache-control-markers.ts';
import { compressCopilotOpenAIChatCompletionsImages } from './compress-images.ts';
import { copilotOpenAIChatCompletionsInitiator } from './set-initiator-header.ts';
import { copilotOpenAIChatCompletionsHasImage } from './set-vision-header.ts';
import type { CopilotUpstreamFacts } from '../../config.ts';
import { headerStage, payloadStage, selectModelStage, unchanged, withPublicModel } from '../shared/stages.ts';
import { defineStage, transform } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { deleteHeader, setHeader, type ProviderInput, type ProviderOpenAIChatCompletionsOutput } from '@floway-dev/provider';

export type ChatInput = ProviderInput<CopilotUpstreamFacts, Omit<OpenAIChatCompletionsPayloadEx, 'model'>>;
type Output = ProviderOpenAIChatCompletionsOutput;

const abortToolArgumentWhitespace = defineStage<{}, {}, Output, Output>({
  name: 'abort-on-tool-argument-whitespace',
  through: {
    request: unchanged,
    response: { needs: ['response.openaiChatCompletions'], consumes: [], provides: ['response.openaiChatCompletions'] },
  },
  execute: transform(scope => ({
    response(back) {
      const outcome = back['response.openaiChatCompletions'];
      if (outcome.kind !== 'stream') return back;
      const events = scope.wrapStream(outcome.events, {
        label: 'chat-completions.tool-arguments',
        transform: abortCopilotOpenAIChatCompletionsToolArgumentWhitespace,
      });
      return { ...back, 'response.openaiChatCompletions': { ...outcome, events } };
    },
  })),
});

export const openAIChatCompletionsStages = [
  // Copilot's Chat Completions endpoint always reports the default service
  // tier, including when a caller sends priority. Keep model selection on the
  // base billing lane.
  selectModelStage<ChatInput>('openaiChatCompletions', ['request.payload'], facts => {
    const effort = facts['request.payload'].reasoning_effort;
    return { reasoningEffort: effort && effort !== 'none' ? effort : undefined };
  }),
  payloadStage<OpenAIChatCompletionsPayloadEx>('compress-images', compressCopilotOpenAIChatCompletionsImages),
  abortToolArgumentWhitespace,
  payloadStage<OpenAIChatCompletionsPayloadEx>('attach-cache-control-markers', attachCopilotCacheControlMarkers),
  headerStage<ChatInput>('set-initiator-header', ['request.payload', 'provider.model'], (facts, headers) =>
    setHeader(headers, 'x-initiator', copilotOpenAIChatCompletionsInitiator(withPublicModel(facts)))),
  headerStage<ChatInput>('set-vision-header', ['request.payload', 'provider.model'], (facts, headers) =>
    copilotOpenAIChatCompletionsHasImage(withPublicModel(facts))
      ? setHeader(headers, 'copilot-vision-request', 'true')
      : deleteHeader(headers, 'copilot-vision-request')),
];
