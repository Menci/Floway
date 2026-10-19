import { irFromOpenAIChatCompletions } from '../../openai-chat-completions/as-target/sse-from.ts';
import { openaiResponsesFromIR } from '../as-source/sse-to.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, customToolNames: ReadonlySet<string> = new Set(), maxChoices = 1): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> =>
  openaiResponsesFromIR(irFromOpenAIChatCompletions(frames, { customToolNames, maxChoices }));
