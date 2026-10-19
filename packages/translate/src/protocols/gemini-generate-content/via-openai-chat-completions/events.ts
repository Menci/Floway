import { irFromOpenAIChatCompletions } from '../../openai-chat-completions/as-target/sse-from.ts';
import { geminiGenerateContentFromIR } from '../as-source/sse-to.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, maxChoices = 1): AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>> =>
  geminiGenerateContentFromIR(irFromOpenAIChatCompletions(frames, { maxChoices }));
