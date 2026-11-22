import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

// ChatGPT rejects these regular OpenAI Responses fields on its subscription
// path. Strip them at the provider boundary so other targets still receive the
// caller's values unchanged.
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

const unsupported = new Set<string>(CHATGPT_UNSUPPORTED_BODY_FIELDS);

export const stripChatGPTUnsupportedFields = <P extends Omit<CanonicalOpenAIResponsesPayload, 'model'>>(payload: P): P =>
  Object.keys(payload).some(key => unsupported.has(key))
    ? Object.fromEntries(Object.entries(payload).filter(([key]) => !unsupported.has(key))) as P
    : payload;
