// Synthesises an OpenAI json_schema core from a Anthropic Messages
// `output_config.format`, consumed by `anthropic-messages-via-openai-responses` and
// `anthropic-messages-via-openai-chat-completions`. Anthropic's shape only carries
// `{ type: 'json_schema', schema }`; OpenAI requires a `name`, so we mint the
// constant `'messages_response'` (mirroring `gemini-generate-content-via-*`'s
// `'gemini_response'`) and set `strict: true`, the closest OpenAI equivalent
// of Anthropic's already-strict structured outputs. Schemas that violate
// OpenAI strict-mode constraints (missing `additionalProperties: false`, …)
// are passed through unmodified and rejected upstream with a clear error
// rather than silently coerced.
//
// The reverse direction (OpenAI response-format → Anthropic Messages) is the source
// protocol's own wire shape — flat for OpenAI Responses, nested for Chat — so each
// `*-via-anthropic-messages` builder extracts it inline rather than sharing a parser.
//
// Anthropic spec: https://platform.claude.com/docs/en/build-with-claude/structured-outputs

import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const ANTHROPIC_MESSAGES_OPENAI_JSON_SCHEMA_NAME = 'messages_response';

type AnthropicMessagesOutputFormat = NonNullable<AnthropicMessagesPayload['output_config']>['format'];

export interface OpenAiJsonSchemaCore {
  name: string;
  strict: true;
  schema: Record<string, unknown>;
}

export const openAiJsonSchemaCoreFromAnthropicMessagesFormat = (format: AnthropicMessagesOutputFormat | undefined): OpenAiJsonSchemaCore | undefined => {
  if (format?.type !== 'json_schema') return undefined;
  return { name: ANTHROPIC_MESSAGES_OPENAI_JSON_SCHEMA_NAME, strict: true, schema: format.schema };
};
