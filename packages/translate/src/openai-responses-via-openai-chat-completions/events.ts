import { irFromOpenAIChatCompletions } from '../shared/ir/sse-from/openai-chat-completions/index.ts';
import { openaiResponsesFromIR } from '../shared/ir/sse-to/openai-responses/index.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, customToolNames: ReadonlySet<string> = new Set()): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> =>
  openaiResponsesFromIR(irFromOpenAIChatCompletions(frames, { customToolNames }));
