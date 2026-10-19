import { irFromAnthropicMessages } from '../../anthropic-messages/as-target/sse-from.ts';
import { openaiResponsesFromIR } from '../as-source/sse-to.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>, responseId: string, customToolNames: ReadonlySet<string> = new Set()): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> =>
  openaiResponsesFromIR(irFromAnthropicMessages(frames, { customToolNames }), { id: responseId });
