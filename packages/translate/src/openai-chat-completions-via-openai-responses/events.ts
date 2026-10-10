import { irFromOpenAIResponses } from '../shared/ir/sse-from/openai-responses/index.ts';
import { openaiChatCompletionsFromIR } from '../shared/ir/sse-to/openai-chat-completions/index.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>): AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> =>
  openaiChatCompletionsFromIR(irFromOpenAIResponses(frames));
