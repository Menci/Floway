import { irFromAnthropicMessages } from '../shared/ir/sse-from/anthropic-messages/index.ts';
import { geminiGenerateContentFromIR } from '../shared/ir/sse-to/gemini-generatecontent/index.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

export const translateToSourceEvents = (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>): AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>> =>
  geminiGenerateContentFromIR(irFromAnthropicMessages(frames));
