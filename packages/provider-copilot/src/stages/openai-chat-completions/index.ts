import { abortCopilotOpenAIChatCompletionsToolArgumentWhitespace } from './abort-on-tool-argument-whitespace.ts';
import { attachCopilotCacheControlMarkers } from './attach-cache-control-markers.ts';
import { compressCopilotOpenAIChatCompletionsImages } from './compress-images.ts';
import { copilotOpenAIChatCompletionsInitiator } from './set-initiator-header.ts';
import { copilotOpenAIChatCompletionsHasImage } from './set-vision-header.ts';
import { headerStage, payloadStage, selectModelStage, unchanged, withPublicModel } from '../shared/stages.ts';
import { defineStage, transform } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { ProviderInput, ProviderServices, ProviderStreamOutput } from '@floway-dev/provider';

export type ChatInput = ProviderInput<Omit<OpenAIChatCompletionsPayloadEx, 'model'>>;
type Output = ProviderStreamOutput<OpenAIChatCompletionsStreamEvent>;

const abortToolArgumentWhitespace = defineStage<{}, {}, Output, Output, ProviderServices>({
  name: 'abort-on-tool-argument-whitespace',
  through: {
    request: unchanged,
    response: { needs: ['response.events'], consumes: [], provides: ['response.events'] },
  },
  execute: transform(env => ({
    response(back) {
      const events = back['response.events'];
      if (events === undefined) return back;
      return {
        ...back,
        'response.events': env.wrapStream(events, {
          label: 'chat-completions.tool-arguments',
          transform: abortCopilotOpenAIChatCompletionsToolArgumentWhitespace,
        }),
      };
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
  headerStage<ChatInput>('set-initiator-header', ['request.payload', 'provider.model'], (facts, headers) => {
    headers.set('x-initiator', copilotOpenAIChatCompletionsInitiator(withPublicModel(facts)));
  }),
  headerStage<ChatInput>('set-vision-header', ['request.payload', 'provider.model'], (facts, headers) => {
    if (copilotOpenAIChatCompletionsHasImage(withPublicModel(facts))) headers.set('copilot-vision-request', 'true');
  }),
];
