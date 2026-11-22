import type { AnthropicMessagesDispatchPlan, AnthropicMessagesRequestFacts } from './types.ts';
import { filterInboundHeaderEntries } from '../../../pipeline/index.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import { applyRulesToUpstreamAnthropicMessages } from '../../shared/alias-rules.ts';
import { SidecarDomain } from '../../shared/sidecar-codec.ts';
import type { StageEnv } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import {
  routeAnthropicMessagesViaOpenAIChatCompletions,
  routeAnthropicMessagesViaOpenAIResponses,
} from '@floway-dev/translate';

const withoutModel = (payload: AnthropicMessagesPayload): Omit<AnthropicMessagesPayload, 'model'> => {
  const { model: _model, ...body } = payload;
  return body;
};

export const inboundHeadersForCandidate = (
  facts: AnthropicMessagesRequestFacts,
  env: StageEnv<ChatPipelineServices>,
): readonly import('@floway-dev/pipeline').HeaderEntry[] => filterInboundHeaderEntries(
  facts['request.inboundHeaders'],
  env.providerFor(facts['route.candidate'].upstreamId).inboundHeaderAllowlist,
);

export const nativeDispatchPlan = (
  facts: AnthropicMessagesRequestFacts,
  env: StageEnv<ChatPipelineServices>,
): Extract<AnthropicMessagesDispatchPlan, { targetApi: 'anthropicMessages' }> => {
  const candidate = facts['route.candidate'];
  const payload = candidate.rules === undefined
    ? facts['request.payload']
    : (() => {
        const cloned = structuredClone(facts['request.payload']);
        applyRulesToUpstreamAnthropicMessages(cloned, candidate.rules);
        return cloned;
      })();
  return {
    type: 'native',
    targetApi: 'anthropicMessages',
    candidate,
    headers: inboundHeadersForCandidate(facts, env),
    payload: withoutModel(payload),
  };
};

export type PreparedAnthropicTranslatedDispatch =
  | {
    readonly type: 'translated';
    readonly targetApi: 'openaiResponses';
    readonly plan: Extract<AnthropicMessagesDispatchPlan, { targetApi: 'openaiResponses' }>;
    readonly trip: import('@floway-dev/translate').TranslateTrip<
      import('@floway-dev/protocols/openai-responses').CanonicalOpenAIResponsesPayload,
      import('@floway-dev/protocols/anthropic-messages').AnthropicMessagesStreamEventEx,
      import('@floway-dev/protocols/openai-responses').OpenAIResponsesStreamEventEx
    >;
  }
  | {
    readonly type: 'translated';
    readonly targetApi: 'openaiChatCompletions';
    readonly plan: Extract<AnthropicMessagesDispatchPlan, { targetApi: 'openaiChatCompletions' }>;
    readonly trip: import('@floway-dev/translate').TranslateTrip<
      import('@floway-dev/protocols/openai-chat-completions').OpenAIChatCompletionsPayloadEx,
      import('@floway-dev/protocols/anthropic-messages').AnthropicMessagesStreamEventEx,
      import('@floway-dev/protocols/openai-chat-completions').OpenAIChatCompletionsStreamEvent
    >;
  };

export const prepareTranslatedDispatch = async (
  facts: AnthropicMessagesRequestFacts,
  env: StageEnv<ChatPipelineServices>,
): Promise<PreparedAnthropicTranslatedDispatch | import('@floway-dev/translate').TranslateInputError> => {
  const targetApi = facts['route.targetApi'];
  if (targetApi === undefined) throw new Error('translated dispatch requires route.targetApi');
  if (targetApi !== 'openaiResponses' && targetApi !== 'openaiChatCompletions') {
    throw new Error(`translatedDispatchPlan received native target ${targetApi}`);
  }
  const options = { sidecarCodec: env.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) };
  if (targetApi === 'openaiResponses') {
    const trip = await routeAnthropicMessagesViaOpenAIResponses(
      { ...facts['request.payload'], stream: true as const },
      options,
    );
    if (trip.type === 'input-error') return trip;
    return {
      type: 'translated',
      targetApi,
      plan: {
        type: 'translated',
        targetApi,
        candidate: facts['route.candidate'],
        headers: inboundHeadersForCandidate(facts, env),
        payload: trip.target,
      },
      trip,
    };
  }
  const trip = await routeAnthropicMessagesViaOpenAIChatCompletions(
    { ...facts['request.payload'], stream: true as const },
    options,
  );
  if (trip.type === 'input-error') return trip;
  return {
    type: 'translated',
    targetApi,
    plan: {
      type: 'translated',
      targetApi,
      candidate: facts['route.candidate'],
      headers: inboundHeadersForCandidate(facts, env),
      payload: trip.target,
    },
    trip,
  };
};
