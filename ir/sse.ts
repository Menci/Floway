
import { irFromAnthropicMessages } from './from-anthropic-messages.ts';
import { irFromOpenAIChatCompletions } from './from-openai-chat-completions.ts';
import { irFromOpenAIResponses } from './from-openai-responses.ts';
import type { IRProtocol } from './ir.ts';
import type { IROutputOptions } from './projection.ts';
import { irFrameToSSEFrame, parseIRStream } from './stream.ts';
import { anthropicMessagesFromIR, type IRMessagesOutputOptions } from './to-anthropic-messages.ts';
import { geminiGenerateContentFromIR, type IRGenerateContentOutputOptions } from './to-gemini-generate-content.ts';
import { openaiChatCompletionsFromIR } from './to-openai-chat-completions.ts';
import { openaiResponsesFromIR } from './to-openai-responses.ts';
import { anthropicMessagesProtocolFrameToSSEFrame, parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import type { SseFrame } from '@floway-dev/protocols/common';
import { geminiGenerateContentProtocolFrameToSSEFrame } from '@floway-dev/protocols/gemini-generate-content';
import { openaiChatCompletionsProtocolFrameToSSEFrame, parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { openaiResponsesProtocolFrameToSSEFrame, parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';

export type IRInboundProtocol = Exclude<IRProtocol, 'geminiGenerateContent'>;

export const protocolSSEToIR = async function* (protocol: IRInboundProtocol, body: ReadableStream<Uint8Array>, options: { signal?: AbortSignal } = {}): AsyncGenerator<SseFrame> {
  const stream = protocol === 'openaiChatCompletions' ? irFromOpenAIChatCompletions(parseOpenAIChatCompletionsStream(body, options))
    : protocol === 'openaiResponses' ? irFromOpenAIResponses(parseOpenAIResponsesStream(body, options))
      : irFromAnthropicMessages(parseAnthropicMessagesStream(body, options));
  for await (const frame of stream) yield irFrameToSSEFrame(frame);
};

export const irSSEToProtocol = async function* (protocol: IRProtocol, body: ReadableStream<Uint8Array>, options: IROutputOptions & IRMessagesOutputOptions & IRGenerateContentOutputOptions, parsing: { signal?: AbortSignal } = {}): AsyncGenerator<SseFrame> {
  const stream = parseIRStream(body, parsing);
  switch (protocol) {
  case 'openaiChatCompletions':
    for await (const frame of openaiChatCompletionsFromIR(stream, options)) {
      const sse = openaiChatCompletionsProtocolFrameToSSEFrame(frame, { includeUsageChunk: true });
      yield sse!;
    }
    break;
  case 'openaiResponses':
    for await (const frame of openaiResponsesFromIR(stream, options)) yield openaiResponsesProtocolFrameToSSEFrame(frame);
    break;
  case 'anthropicMessages':
    for await (const frame of anthropicMessagesFromIR(stream, options)) {
      const sse = anthropicMessagesProtocolFrameToSSEFrame(frame);
      yield sse!;
    }
    break;
  case 'geminiGenerateContent':
    for await (const frame of geminiGenerateContentFromIR(stream, options)) {
      const sse = geminiGenerateContentProtocolFrameToSSEFrame(frame);
      yield sse!;
    }
    break;
  }
};
