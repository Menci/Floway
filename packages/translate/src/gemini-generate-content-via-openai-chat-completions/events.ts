import { irFromOpenAIChatCompletions } from '../shared/ir/sse-from/openai-chat-completions/index.ts';
import { geminiGenerateContentFromIR } from '../shared/ir/sse-to/gemini-generatecontent/index.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>): AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>> =>
  geminiGenerateContentFromIR(irFromOpenAIChatCompletions(frames));
