import { irFromOpenAIChatCompletions } from '../../openai-chat-completions/as-target/sse-from.ts';
import { anthropicMessagesFromIR } from '../as-source/sse-to.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, maxChoices = 1): AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>> =>
  anthropicMessagesFromIR(irFromOpenAIChatCompletions(frames, { maxChoices }));
