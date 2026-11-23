import { contentTypeOf } from './body-render';
import { sanitizeDecodedForJson } from './format-value';
import { errorMessage } from '../../lib/error-message';
import type { DecodedStreamNode, ProjectedWireResponse } from '@floway-dev/dump/browser';
import { Bytes } from '@floway-dev/pipeline/browser';
import {
  anthropicMessagesProtocolFrameToSSEFrame,
  collectAnthropicMessagesProtocolEventsToResult,
  collectGeminiGenerateContentProtocolEventsToResult,
  collectOpenAIChatCompletionsProtocolEventsToResult,
  collectOpenAIResponsesProtocolEventsToResult,
  createSSEFrameParser,
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
  readonly capturedSse?: SseFrame | SseRawFrame;
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

const bytesFrame = (value: unknown): Bytes => {
  if (!(value instanceof Bytes)) throw new TypeError('Expected bytes in a wire stream');
  return value;
};

const parseSseFrames = (stream: DecodedStreamNode): StreamFrameEntry[] => {
  const decoder = new TextDecoder();
  const entries: StreamFrameEntry[] = [];
  let timestamp = stream.createdAtMs;
  const parser = createSSEFrameParser(capturedSse => {
    const text = capturedSse.data;
    let frame: ProtocolFrame<unknown> = { type: 'done' };
    if (text.trim() !== '[DONE]') {
      let payload: unknown = text;
      try { payload = JSON.parse(text) as unknown; } catch { /* Raw payloads remain visible. */ }
      frame = { type: 'event', event: payload };
    }
    entries.push({ frame, ts: timestamp, deltaMs: timestamp - (entries.at(-1)?.ts ?? timestamp), capturedSse });
  });
  for (const frame of stream.frames) {
    timestamp = frame.tMs;
    parser.feed(decoder.decode(bytesFrame(frame.value).toUint8Array(), { stream: true }));
  }
  if (stream.end?.how === 'exhausted') parser.feed(`${decoder.decode()}\n\n`);
  return entries;
};

export const extractWireStreamFrames = (response: ProjectedWireResponse | null): StreamFrameEntry[] =>
  response?.stream !== undefined && contentTypeOf(response.headers).toLowerCase().includes('text/event-stream')
    ? parseSseFrames(response.stream) : [];

export const extractRawWireBytes = (response: ProjectedWireResponse | null): Uint8Array | null =>
  response?.body instanceof Bytes ? response.body.toUint8Array()
    : response?.stream?.frames.length ? Bytes.concat(response.stream.frames.map(frame => bytesFrame(frame.value))).toUint8Array() : null;

export const streamEndedCleanly = (events: readonly StreamFrameEntry[]): boolean =>
  events.at(-1)?.frame.type === 'done';

const complete = (result: unknown, ended: boolean): CollectedStream =>
  ({ result, error: null, truncated: !ended });

const frames = async function* (events: readonly StreamFrameEntry[]): AsyncGenerator<ProtocolFrame<unknown>> {
  for (const event of events) yield event.frame;
};

export const collectStream = async (kind: CollectKind, events: readonly StreamFrameEntry[], ended = streamEndedCleanly(events)): Promise<CollectedStream> => {
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
        for (const { frame } of events) {
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

export const renderStreamEvents = (kind: CollectKind | null, events: readonly StreamFrameEntry[]): RenderedStreamEvent[] => {
  return events.map(({ frame, ts, deltaMs, sseEvent, capturedSse }) => {
    const sse = capturedSse ?? frameToSse(kind, frame, sseEvent);
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
  return events.map(({ frame, sseEvent, capturedSse }) => {
    const sse = capturedSse ?? frameToSse(kind, frame, sseEvent);
    if (!sse) return '';
    if (sse.type === 'sse-raw') return sse.data;
    return `${sse.event ? `event: ${sse.event}\n` : ''}${sse.data.split('\n').map(line => `data: ${line}\n`).join('')}`;
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
