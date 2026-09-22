import { errorMessage } from '../../lib/error-message';
import type { DumpStreamEvent } from '@floway-dev/gateway/dump-types';
import {
  collectAnthropicMessagesProtocolEventsToResult,
  anthropicMessagesProtocolFrameToSSEFrame,
} from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame, SseFrame } from '@floway-dev/protocols/common';
import {
  collectGeminiGenerateContentProtocolEventsToResult,
  geminiGenerateContentProtocolFrameToSSEFrame,
  type GeminiGenerateContentStreamEvent,
} from '@floway-dev/protocols/gemini-generate-content';
import {
  openaiChatCompletionsProtocolFrameToSSEFrame,
  collectOpenAIChatCompletionsProtocolEventsToResult,
} from '@floway-dev/protocols/openai-chat-completions';
import {
  openaiCompletionsProtocolFrameToSSEFrame,
  reassembleOpenAICompletionsEvents,
  type OpenAICompletionsStreamEvent,
} from '@floway-dev/protocols/openai-completions';
import {
  collectOpenAIResponsesProtocolEventsToResult,
  openaiResponsesProtocolFrameToSSEFrame,
} from '@floway-dev/protocols/openai-responses';

export type CollectKind = 'openai-completions' | 'openai-chat-completions' | 'anthropic-messages' | 'openai-responses' | 'gemini-generate-content';

export interface CollectedStream {
  result: unknown | null;
  error: string | null;
  truncated: boolean;
}

export interface RenderedStreamEvent {
  event: string | null;
  text: string;
  parseError: string | null;
  timestamp: number;
}

export const detectCollectKind = (path: string): CollectKind | null => {
  if (path.includes('/messages')) return 'anthropic-messages';
  if (path.includes('/responses')) return 'openai-responses';
  if (path.includes('/chat/completions')) return 'openai-chat-completions';
  if (path.includes('/completions')) return 'openai-completions';
  if (path.includes('/v1beta/') || path.includes(':generateContent')) return 'gemini-generate-content';
  return null;
};

export const streamEndedCleanly = (events: DumpStreamEvent[]): boolean =>
  events.at(-1)?.frame.type === 'done';

const complete = (result: unknown, events: DumpStreamEvent[]): CollectedStream =>
  ({ result, error: null, truncated: !streamEndedCleanly(events) });

export const collectStream = async (kind: CollectKind, events: DumpStreamEvent[]): Promise<CollectedStream> => {
  try {
    switch (kind) {
    case 'openai-chat-completions':
      return complete(await collectOpenAIChatCompletionsProtocolEventsToResult(frames(events) as never), events);
    case 'anthropic-messages':
      return complete(await collectAnthropicMessagesProtocolEventsToResult(frames(events) as never), events);
    case 'openai-responses':
      return complete(await collectOpenAIResponsesProtocolEventsToResult(frames(events) as never), events);
    case 'gemini-generate-content':
      return complete(await collectGeminiGenerateContentProtocolEventsToResult(frames(events) as AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>), events);
    case 'openai-completions': {
      const stream = (async function* () {
        for (const { frame } of events) {
          const typed = frame as ProtocolFrame<OpenAICompletionsStreamEvent>;
          if (typed.type === 'event') yield typed.event;
        }
      })();
      return complete(await reassembleOpenAICompletionsEvents(stream), events);
    }
    }
  } catch (error) {
    return { result: null, error: errorMessage(error), truncated: true };
  }
};

export const renderStreamEvents = (kind: CollectKind | null, events: DumpStreamEvent[]): RenderedStreamEvent[] => {
  return events.map(({ frame, ts }) => {
    const sse = frameToSse(kind, frame);
    if (!sse) return { event: null, text: '', parseError: null, timestamp: ts };
    try {
      return { event: sse.event ?? null, text: JSON.stringify(JSON.parse(sse.data) as unknown, null, 2), parseError: null, timestamp: ts };
    } catch (error) {
      return { event: sse.event ?? null, text: sse.data, parseError: errorMessage(error), timestamp: ts };
    }
  });
};

export const streamEventsCopyText = (kind: CollectKind | null, events: DumpStreamEvent[]): string => {
  return events.map(({ frame }) => {
    const sse = frameToSse(kind, frame);
    return sse ? `${sse.event ? `event: ${sse.event}\n` : ''}data: ${sse.data}\n` : '';
  }).filter(Boolean).join('\n');
};

async function* frames(events: DumpStreamEvent[]) {
  for (const event of events) yield event.frame;
}

const frameToSse = (kind: CollectKind | null, frame: ProtocolFrame<unknown>): SseFrame | null => {
  try {
    switch (kind) {
    case 'openai-chat-completions': return openaiChatCompletionsProtocolFrameToSSEFrame(frame as never, { includeUsageChunk: true });
    case 'openai-completions': return openaiCompletionsProtocolFrameToSSEFrame(frame as never);
    case 'anthropic-messages': return anthropicMessagesProtocolFrameToSSEFrame(frame as never);
    case 'openai-responses': return openaiResponsesProtocolFrameToSSEFrame(frame as never);
    case 'gemini-generate-content': return geminiGenerateContentProtocolFrameToSSEFrame(frame as never);
    default: return null;
    }
  } catch (error) {
    return { type: 'sse', event: 'serialize_error', data: errorMessage(error) };
  }
};
