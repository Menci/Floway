import { contentTypeOf } from './body-render';
import { sanitizeDecodedForJson } from './format-value';
import { errorMessage } from '../../lib/error-message';
import type { ProjectedWireResponse } from '@floway-dev/pipeline/browser';
import {
  anthropicMessagesProtocolFrameToSSEFrame,
  collectAnthropicMessagesProtocolEventsToResult,
  collectGeminiGenerateContentProtocolEventsToResult,
  collectOpenAIChatCompletionsProtocolEventsToResult,
  collectOpenAIResponsesProtocolEventsToResult,
  geminiGenerateContentProtocolFrameToSSEFrame,
  openaiChatCompletionsProtocolFrameToSSEFrame,
  openaiCompletionsProtocolFrameToSSEFrame,
  openaiResponsesProtocolFrameToSSEFrame,
  reassembleOpenAICompletionsEvents,
  type GeminiGenerateContentStreamEvent,
  type OpenAICompletionsStreamEvent,
  type ProtocolFrame,
  type SseFrame,
  type SseRawFrame,
} from '@floway-dev/protocols/browser';

export type CollectKind = 'openai-completions' | 'openai-chat-completions' | 'anthropic-messages' | 'openai-responses' | 'gemini-generate-content';

export interface StreamFrameEntry {
  readonly frame: ProtocolFrame<unknown>;
  readonly ts: number;
  readonly deltaMs?: number;
  readonly sseEvent?: string;
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
  deltaMs?: number;
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

// The upstream view uses meta.targetApi, stamped by dump completion, because
// meta.path identifies the client protocol.
export const collectKindFromTargetApi = (api: string | null | undefined): CollectKind | null => {
  if (api === 'anthropicMessages') return 'anthropic-messages';
  if (api === 'geminiGenerateContent') return 'gemini-generate-content';
  if (api === 'openaiResponses') return 'openai-responses';
  if (api === 'openaiChatCompletions') return 'openai-chat-completions';
  return null;
};

const isProtocolFrame = (value: unknown): value is ProtocolFrame<unknown> =>
  typeof value === 'object' && value !== null && !(value instanceof Uint8Array) && 'type' in value;

const concatBytes = (chunks: readonly Uint8Array[]): Uint8Array => {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const parseSseFrames = (bytes: Uint8Array, firstTimestamp: number): StreamFrameEntry[] => {
  const text = new TextDecoder().decode(bytes);
  const entries: StreamFrameEntry[] = [];
  let timestamp = firstTimestamp;
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event: string | null = null;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trimStart();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    const payload = data.join('\n');
    const eventField = event === null ? {} : { sseEvent: event };
    if (payload.trim() === '[DONE]') {
      entries.push({ frame: { type: 'done' }, ts: timestamp, ...eventField });
    } else {
      let parsed: unknown = payload;
      try { parsed = JSON.parse(payload) as unknown; } catch { /* Raw SSE payloads remain visible. */ }
      entries.push({
        frame: { type: 'event', event: parsed },
        ts: timestamp,
        ...eventField,
      });
    }
    timestamp += 1;
  }
  return entries;
};

export const extractWireStreamFrames = (
  response: ProjectedWireResponse | null,
  direction: 'upstream' | 'downstream',
): StreamFrameEntry[] => {
  if (response === null) return [];
  if (direction === 'downstream' && response.clientFrames?.some(entry => isProtocolFrame(entry.value))) {
    return response.clientFrames
      .filter(entry => isProtocolFrame(entry.value))
      .map(entry => ({ frame: entry.value as ProtocolFrame<unknown>, ts: entry.tMs, deltaMs: entry.deltaMs }));
  }
  if (response.protocolFrames.length > 0) {
    return response.protocolFrames
      .filter(entry => isProtocolFrame(entry.value))
      .map(entry => ({ frame: entry.value as ProtocolFrame<unknown>, ts: entry.tMs, deltaMs: entry.deltaMs }));
  }
  if (response.rawFrames.length > 0 && contentTypeOf(response.headers).toLowerCase().includes('text/event-stream')) {
    const chunks = response.rawFrames
      .map(entry => entry.value)
      .filter((value): value is Uint8Array => value instanceof Uint8Array);
    return parseSseFrames(concatBytes(chunks), response.rawFrames[0]?.tMs ?? 0);
  }
  return [];
};

export const extractRawWireBytes = (response: ProjectedWireResponse | null): Uint8Array | null => {
  if (response === null) return null;
  const rawFrames = response.rawFrames.map(entry => entry.value);
  if (rawFrames.length > 0 && rawFrames.every((chunk): chunk is Uint8Array => chunk instanceof Uint8Array)) return concatBytes(rawFrames);
  const clientFrames = response.clientFrames?.map(entry => entry.value) ?? [];
  if (clientFrames.length > 0 && clientFrames.every((chunk): chunk is Uint8Array => chunk instanceof Uint8Array)) return concatBytes(clientFrames);
  return response.rawBody instanceof Uint8Array ? response.rawBody : null;
};

export const streamEndedCleanly = (events: readonly StreamFrameEntry[]): boolean =>
  events.at(-1)?.frame.type === 'done';

const complete = (result: unknown, events: readonly StreamFrameEntry[]): CollectedStream =>
  ({ result, error: null, truncated: !streamEndedCleanly(events) });

const frames = async function* (events: readonly StreamFrameEntry[]): AsyncGenerator<ProtocolFrame<unknown>> {
  for (const event of events) yield event.frame;
};

export const collectStream = async (kind: CollectKind, events: readonly StreamFrameEntry[]): Promise<CollectedStream> => {
  try {
    switch (kind) {
    case 'openai-chat-completions':
      return complete(await collectOpenAIChatCompletionsProtocolEventsToResult(frames(events) as AsyncIterable<never>), events);
    case 'anthropic-messages':
      return complete(await collectAnthropicMessagesProtocolEventsToResult(frames(events) as AsyncIterable<never>), events);
    case 'openai-responses':
      return complete(await collectOpenAIResponsesProtocolEventsToResult(frames(events) as AsyncIterable<never>), events);
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

export const renderStreamEvents = (kind: CollectKind | null, events: readonly StreamFrameEntry[]): RenderedStreamEvent[] => {
  return events.map(({ frame, ts, deltaMs, sseEvent }) => {
    const sse = frameToSse(kind, frame, sseEvent);
    const timing = deltaMs === undefined ? {} : { deltaMs };
    if (!sse) return { event: null, text: '', parseError: null, timestamp: ts, ...timing };
    const event = sse.type === 'sse' ? sse.event ?? null : null;
    if (frame.type === 'done') return { event: event ?? '[DONE]', text: sse.data, parseError: null, timestamp: ts, ...timing };
    try {
      return { event, text: JSON.stringify(JSON.parse(sse.data) as unknown, null, 2), parseError: null, timestamp: ts, ...timing };
    } catch (error) {
      return { event, text: sse.data, parseError: errorMessage(error), timestamp: ts, ...timing };
    }
  });
};

export const streamEventsCopyText = (kind: CollectKind | null, events: readonly StreamFrameEntry[]): string => {
  return events.map(({ frame, sseEvent }) => {
    const sse = frameToSse(kind, frame, sseEvent);
    if (!sse) return '';
    if (sse.type === 'sse-raw') return sse.data;
    return `${sse.event ? `event: ${sse.event}\n` : ''}data: ${sse.data}\n`;
  }).filter(Boolean).join('\n');
};

const withFallbackEvent = (sse: SseFrame | SseRawFrame | null, sseEvent?: string): SseFrame | SseRawFrame | null =>
  sse?.type === 'sse' && sse.event === undefined && sseEvent !== undefined ? { ...sse, event: sseEvent } : sse;

const frameToSse = (kind: CollectKind | null, frame: ProtocolFrame<unknown>, sseEvent?: string): SseFrame | SseRawFrame | null => {
  try {
    switch (kind) {
    case 'openai-chat-completions': return withFallbackEvent(openaiChatCompletionsProtocolFrameToSSEFrame(frame as never, { includeUsageChunk: true }), sseEvent);
    case 'openai-completions': return withFallbackEvent(openaiCompletionsProtocolFrameToSSEFrame(frame as never), sseEvent);
    case 'anthropic-messages': return withFallbackEvent(anthropicMessagesProtocolFrameToSSEFrame(frame as never), sseEvent);
    case 'openai-responses': return withFallbackEvent(openaiResponsesProtocolFrameToSSEFrame(frame as never), sseEvent);
    case 'gemini-generate-content': return withFallbackEvent(geminiGenerateContentProtocolFrameToSSEFrame(frame as never), sseEvent);
    default:
      if (frame.type === 'done') return withFallbackEvent({ type: 'sse', data: '[DONE]' }, sseEvent);
      return withFallbackEvent({
        type: 'sse',
        data: typeof frame.event === 'string' ? frame.event : JSON.stringify(sanitizeDecodedForJson(frame.event)),
      }, sseEvent);
    }
  } catch (error) {
    return { type: 'sse', event: 'serialize_error', data: errorMessage(error) };
  }
};
