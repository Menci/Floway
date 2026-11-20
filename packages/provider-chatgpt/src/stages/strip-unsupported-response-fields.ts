import type { ChatGPTAccountFacts } from '../pipeline-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ProviderChatResponse, ProviderChatServices } from '@floway-dev/provider';

type Request = ChatGPTAccountFacts<'openaiResponses' | 'openaiResponsesCompact'>;

// ChatGPT backend rejects requests carrying any of these fields with a
// `Unsupported parameter: <name>` 4xx. They are regular OpenAI Responses API
// fields that the ChatGPT-subscription path does not honor. Source-protocol
// translators legitimately set max_output_tokens / temperature / top_p (the
// caller's request might carry them), so we strip them at the ChatGPT target
// boundary rather than at translation time, where they remain valid for
// other providers.
const CHATGPT_UNSUPPORTED_BODY_FIELDS = [
  'max_output_tokens',
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'user',
  'metadata',
  'prompt_cache_retention',
  'safety_identifier',
  'stream_options',
] as const;

const isUnsupportedField = (key: string): boolean => (CHATGPT_UNSUPPORTED_BODY_FIELDS as readonly string[]).includes(key);

export const supportedResponsesPayload = <P extends Omit<CanonicalOpenAIResponsesPayload, 'model'>>(payload: P): P =>
  Object.keys(payload).some(isUnsupportedField)
    ? Object.fromEntries(Object.entries(payload).filter(([key]) => !isUnsupportedField(key))) as P
    : payload;

export const stripChatGPTUnsupportedFields = defineStage<Request, Request, ProviderChatResponse<'openaiResponses'>, ProviderChatResponse<'openaiResponses'>, ProviderChatServices>({
  name: 'stripChatGPTUnsupportedFields',
  through: {
    request: { needs: ['request.provider.payload'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => move({
    ...await next(move({ ...facts, 'request.provider.payload': supportedResponsesPayload(facts['request.provider.payload']) })),
  }),
});
