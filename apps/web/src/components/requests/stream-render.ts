import { errorMessage } from '../../lib/error-message';
import type { DumpStreamEvent } from '@floway-dev/gateway/dump-types';
import {
  chatCompletionsProtocolFrameToSSEFrame,
  collectChatCompletionsProtocolEventsToResult,
} from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame, SseFrame } from '@floway-dev/protocols/common';
import {
  completionsProtocolFrameToSSEFrame,
  reassembleCompletionsEvents,
  type CompletionsStreamEvent,
} from '@floway-dev/protocols/completions';
import {
  collectGeminiProtocolEventsToResult,
  geminiProtocolFrameToSSEFrame,
  type GeminiStreamEvent,
} from '@floway-dev/protocols/gemini';
import {
  collectMessagesProtocolEventsToResult,
  messagesProtocolFrameToSSEFrame,
} from '@floway-dev/protocols/messages';
import {
  collectResponsesProtocolEventsToResult,
  responsesProtocolFrameToSSEFrame,
} from '@floway-dev/protocols/responses';

export type CollectKind = 'completions' | 'chat-completions' | 'messages' | 'responses' | 'gemini';

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
  if (path.includes('/messages')) return 'messages';
  if (path.includes('/responses')) return 'responses';
  if (path.includes('/chat/completions')) return 'chat-completions';
  if (path.includes('/completions')) return 'completions';
  if (path.includes('/v1beta/') || path.includes(':generateContent')) return 'gemini';
  return null;
};

export const streamEndedCleanly = (events: DumpStreamEvent[]): boolean =>
  events.at(-1)?.frame.type === 'done';

const complete = (result: unknown, events: DumpStreamEvent[]): CollectedStream =>
  ({ result, error: null, truncated: !streamEndedCleanly(events) });

export const collectStream = async (kind: CollectKind, events: DumpStreamEvent[]): Promise<CollectedStream> => {
  try {
    switch (kind) {
    case 'chat-completions':
      return complete(await collectChatCompletionsProtocolEventsToResult(frames(events) as never), events);
    case 'messages':
      return complete(await collectMessagesProtocolEventsToResult(frames(events) as never), events);
    case 'responses':
      return complete(await collectResponsesProtocolEventsToResult(frames(events) as never), events);
    case 'gemini':
      return complete(await collectGeminiProtocolEventsToResult(frames(events) as AsyncIterable<ProtocolFrame<GeminiStreamEvent>>), events);
    case 'completions': {
      const stream = (async function* () {
        for (const { frame } of events) {
          const typed = frame as ProtocolFrame<CompletionsStreamEvent>;
          if (typed.type === 'event') yield typed.event;
        }
      })();
      return complete(await reassembleCompletionsEvents(stream), events);
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
    case 'chat-completions': return chatCompletionsProtocolFrameToSSEFrame(frame as never, { includeUsageChunk: true });
    case 'completions': return completionsProtocolFrameToSSEFrame(frame as never);
    case 'messages': return messagesProtocolFrameToSSEFrame(frame as never);
    case 'responses': return responsesProtocolFrameToSSEFrame(frame as never);
    case 'gemini': return geminiProtocolFrameToSSEFrame(frame as never);
    default: return null;
    }
  } catch (error) {
    return { type: 'sse', event: 'serialize_error', data: errorMessage(error) };
  }
};
