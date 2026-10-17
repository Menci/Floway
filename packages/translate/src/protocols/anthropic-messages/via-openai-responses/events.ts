import { irFromOpenAIResponses } from '../../openai-responses/as-target/sse-from.ts';
import { anthropicMessagesFromIR } from '../as-source/sse-to.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>): AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>> =>
  anthropicMessagesFromIR(irFromOpenAIResponses(frames));
