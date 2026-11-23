import { contentTypeOf } from './body-render';
import { errorMessage } from '../../lib/error-message';
import type { ProjectedWireResponse } from '@floway-dev/dump/browser';
import { Bytes } from '@floway-dev/pipeline/browser';
import {
  collectAnthropicMessagesProtocolEventsToResult,
  collectGeminiGenerateContentProtocolEventsToResult,
  collectOpenAIChatCompletionsProtocolEventsToResult,
  collectOpenAIResponsesProtocolEventsToResult,
  createSSEFrameParser,
  reassembleOpenAICompletionsEvents,
  type GeminiGenerateContentStreamEvent,
  type OpenAICompletionsStreamEvent,
  type ProtocolFrame,
  type SseFrame,
  type SseRawFrame,
} from '@floway-dev/protocols/browser';

export type CollectKind = 'openai-completions' | 'openai-chat-completions' | 'anthropic-messages' | 'openai-responses' | 'gemini-generate-content';

export interface StreamFrameEntry {
  readonly sse: SseFrame | SseRawFrame;
  readonly ts: number;
  readonly deltaMs: number;
}

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
  deltaMs: number;
}

export const detectCollectKind = (path: string): CollectKind | null => {
  if (path.includes('/messages')) return 'anthropic-messages';
  if (path.includes('/responses')) return 'openai-responses';
  if (path.includes('/chat/completions')) return 'openai-chat-completions';
  if (path.includes('/completions')) return 'openai-completions';
  // A Gemini turn carries its action in the model path segment
  // (`…:generateContent`), optionally followed by `?alt=sse`. The listing
  // paths end at `/models`, so the action name discriminates regardless of
  // whether the turn arrived under `v1` or `v1beta`.
  if (/:(?:generateContent|streamGenerateContent|countTokens)(?:\?|$)/.test(path)) return 'gemini-generate-content';
  return null;
};

// The recorded target protocol covers upstream paths that carry no protocol name.
export const collectKindFromTargetApi = (api: string | null | undefined): CollectKind | null => {
  if (api === 'anthropicMessages') return 'anthropic-messages';
  if (api === 'geminiGenerateContent') return 'gemini-generate-content';
  if (api === 'openaiResponses') return 'openai-responses';
  if (api === 'openaiChatCompletions') return 'openai-chat-completions';
  return null;
};

interface WireResponseBody {
  readonly frames: StreamFrameEntry[];
  readonly bytes: Uint8Array | null;
  readonly ended: boolean;
  readonly transportFailed: boolean;
}

export const readWireResponseBody = (response: ProjectedWireResponse | null): WireResponseBody => {
  const stream = response?.stream;
  let transportFailed = response?.transportError !== undefined;
  if (response === null || stream === undefined) {
    const body = response?.body;
    return { frames: [], bytes: body instanceof Bytes ? body.toUint8Array() : null, ended: false, transportFailed };
  }

  const frames: StreamFrameEntry[] = [];
  const chunks: Bytes[] = [];
  const decoder = new TextDecoder();
  let timestamp = stream.createdAtMs;
  const parser = contentTypeOf(response.headers).toLowerCase().includes('text/event-stream')
    ? createSSEFrameParser(sse => {
        frames.push({ sse, ts: timestamp, deltaMs: timestamp - (frames.at(-1)?.ts ?? timestamp) });
      })
    : null;
  for (const { value, tMs } of stream.frames) {
    if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'transport-error' && 'error' in value) {
      transportFailed = true;
      continue;
    }
    if (!(value instanceof Bytes)) throw new TypeError('Expected bytes or a transport failure in a wire stream');
    timestamp = tMs;
    chunks.push(value);
    parser?.feed(decoder.decode(value.toUint8Array(), { stream: true }));
  }
  const ended = stream.end?.how === 'exhausted' && !transportFailed;
  if (ended) parser?.feed(`${decoder.decode()}\n\n`);
  const bytes = chunks.length > 0 ? Bytes.concat(chunks).toUint8Array() : null;
  return { frames, bytes, ended, transportFailed };
};

const complete = (result: unknown, ended: boolean): CollectedStream =>
  ({ result, error: null, truncated: !ended });

const frames = async function* (events: readonly StreamFrameEntry[]): AsyncGenerator<ProtocolFrame<unknown>> {
  for (const { sse } of events) {
    if (sse.type === 'sse' && sse.data.trim() === '[DONE]') {
      yield { type: 'done' };
    } else {
      yield { type: 'event', event: JSON.parse(sse.data) as unknown };
    }
  }
};

export const collectStream = async (kind: CollectKind, events: readonly StreamFrameEntry[], ended: boolean): Promise<CollectedStream> => {
  try {
    switch (kind) {
    case 'openai-chat-completions':
      return complete(await collectOpenAIChatCompletionsProtocolEventsToResult(frames(events) as AsyncIterable<never>), ended);
    case 'anthropic-messages':
      return complete(await collectAnthropicMessagesProtocolEventsToResult(frames(events) as AsyncIterable<never>), ended);
    case 'openai-responses':
      return complete(await collectOpenAIResponsesProtocolEventsToResult(frames(events) as AsyncIterable<never>), ended);
    case 'gemini-generate-content':
      return complete(await collectGeminiGenerateContentProtocolEventsToResult(frames(events) as AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>), ended);
    case 'openai-completions': {
      const stream = (async function* () {
        for await (const frame of frames(events)) {
          const typed = frame as ProtocolFrame<OpenAICompletionsStreamEvent>;
          if (typed.type === 'event') yield typed.event;
        }
      })();
      return complete(await reassembleOpenAICompletionsEvents(stream), ended);
    }
    }
  } catch (error) {
    return { result: null, error: errorMessage(error), truncated: true };
  }
};

export const renderStreamEvents = (events: readonly StreamFrameEntry[]): RenderedStreamEvent[] => {
  return events.map(({ sse, ts, deltaMs }) => {
    const event = sse.type === 'sse' ? sse.event ?? null : null;
    if (sse.type === 'sse' && sse.data.trim() === '[DONE]')
      return { event: event ?? '[DONE]', text: sse.data, parseError: null, timestamp: ts, deltaMs };
    try {
      return { event, text: JSON.stringify(JSON.parse(sse.data) as unknown, null, 2), parseError: null, timestamp: ts, deltaMs };
    } catch (error) {
      return { event, text: sse.data, parseError: errorMessage(error), timestamp: ts, deltaMs };
    }
  });
};

export const streamEventsCopyText = (events: readonly StreamFrameEntry[]): string => {
  return events.map(({ sse }) => {
    if (sse.type === 'sse-raw') return sse.data;
    return `${sse.event ? `event: ${sse.event}\n` : ''}${sse.data.split('\n').map(line => `data: ${line}\n`).join('')}`;
  }).join('\n');
};
