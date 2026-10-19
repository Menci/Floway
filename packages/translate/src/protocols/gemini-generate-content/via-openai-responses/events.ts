import { irFromOpenAIResponses } from '../../openai-responses/as-target/sse-from.ts';
import { geminiGenerateContentFromIR } from '../as-source/sse-to.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>): AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>> =>
  geminiGenerateContentFromIR(irFromOpenAIResponses(frames));
