import { irFromOpenAIResponses } from '../shared/ir/sse-from/openai-responses/index.ts';
import { geminiGenerateContentFromIR } from '../shared/ir/sse-to/gemini-generatecontent/index.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>): AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>> =>
  geminiGenerateContentFromIR(irFromOpenAIResponses(frames));
