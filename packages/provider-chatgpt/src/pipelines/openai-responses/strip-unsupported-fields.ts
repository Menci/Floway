import { chatgptFactSpace } from '../facts.ts';
import { transform } from '@floway-dev/pipeline';

const { defineStage } = chatgptFactSpace;

// ChatGPT backend rejects requests carrying any of these fields with a
// `Unsupported parameter: <name>` 4xx. They are regular OpenAI Responses API
// fields that the ChatGPT-subscription path does not honor. Source-protocol
// translators legitimately set max_output_tokens / temperature / top_p (the
// caller's request might carry them). Strip them only at the ChatGPT boundary.
// https://github.com/Wei-Shaw/sub2api/pull/1789/commits/08a348437cbcfd0c1cdd08a1c4816316ac5db724
// https://github.com/BerriAI/litellm/issues/21193
interface UnsupportedFields {
  max_output_tokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  frequency_penalty?: unknown;
  presence_penalty?: unknown;
  user?: unknown;
  metadata?: unknown;
  prompt_cache_retention?: unknown;
  safety_identifier?: unknown;
  stream_options?: unknown;
}

const omitUnsupportedFields = <Payload extends UnsupportedFields>({
  max_output_tokens: _max_output_tokens,
  temperature: _temperature,
  top_p: _top_p,
  frequency_penalty: _frequency_penalty,
  presence_penalty: _presence_penalty,
  user: _user,
  metadata: _metadata,
  prompt_cache_retention: _prompt_cache_retention,
  safety_identifier: _safety_identifier,
  stream_options: _stream_options,
  ...payload
}: Payload) => payload;

const unchanged = { needs: [], provides: [], consumes: [] } as const;

export const stripOpenAIResponsesUnsupportedFields = defineStage({
  name: 'chatgpt.openaiResponses.strip-unsupported-fields',
  through: {
    request: { needs: ['request.openaiResponses'], provides: ['request.openaiResponses'], consumes: [] },
    response: unchanged,
  },
  execute: transform(() => ({
    request: facts => ({ ...facts, 'request.openaiResponses': omitUnsupportedFields(facts['request.openaiResponses']) }),
  })),
});

export const stripOpenAIResponsesCompactUnsupportedFields = defineStage({
  name: 'chatgpt.openaiResponsesCompact.strip-unsupported-fields',
  through: {
    request: { needs: ['request.openaiResponsesCompact'], provides: ['request.openaiResponsesCompact'], consumes: [] },
    response: unchanged,
  },
  execute: transform(() => ({
    request: facts => ({ ...facts, 'request.openaiResponsesCompact': omitUnsupportedFields(facts['request.openaiResponsesCompact']) }),
  })),
});
