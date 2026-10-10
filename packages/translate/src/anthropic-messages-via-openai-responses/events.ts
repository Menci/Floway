import { irFromOpenAIResponses } from '../shared/ir/sse-from/openai-responses/index.ts';
import { anthropicMessagesFromIR } from '../shared/ir/sse-to/anthropic-messages/index.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>): AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>> =>
  anthropicMessagesFromIR(irFromOpenAIResponses(frames));
