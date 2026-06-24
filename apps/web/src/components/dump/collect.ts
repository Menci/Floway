// Cold-dump fold dispatch. The dashboard hands us a recorded
// `DumpStreamEvent[]` and we fold it back into the protocol's
// non-streaming envelope by handing the stored `ProtocolFrame`s straight
// to the same per-protocol reassembler the gateway runs against a live
// upstream.
//
// Streams may be partial (truncated dump, mid-stream error), so the
// outcome reports `truncated` and `error` rather than throwing:
//
//   - happy path:       result populated, error null, truncated false
//   - truncated:        result populated best-effort, error null, truncated true
//   - mid-stream error: result populated best-effort, error set, truncated true
//   - catastrophic:     result null, error set, truncated true

import type { DumpStreamEvent } from '@floway-dev/gateway/dump-types';
import {
  chatCompletionsErrorPayloadMessage,
  type ChatCompletionsResult,
  type ChatCompletionsStreamEvent,
  reassembleChatCompletionsEvents,
} from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import {
  type CompletionsResult,
  type CompletionsStreamEvent,
  reassembleCompletionsEvents,
} from '@floway-dev/protocols/completions';
import {
  collectGeminiProtocolEventsToResult,
  type GeminiResult,
  type GeminiStreamEvent,
  isGeminiErrorEvent,
  isGeminiTerminalEvent,
} from '@floway-dev/protocols/gemini';
import {
  type MessagesResult,
  type MessagesStreamEvent,
  reassembleMessagesEvents,
} from '@floway-dev/protocols/messages';
import {
  isResponsesTerminalEvent,
  reassembleResponsesEvents,
  type ResponsesResult,
  type ResponsesStreamEvent,
} from '@floway-dev/protocols/responses';

export interface CollectOutcome<TResult> {
  result: TResult | null;
  error: string | null;
  truncated: boolean;
}

export type CollectKind = 'completions' | 'chat-completions' | 'messages' | 'responses' | 'gemini';

export const detectCollectKind = (path: string): CollectKind | null => {
  // `/completions` is a substring of `/chat/completions`, so the
  // chat-completions probe must run first.
  if (path.includes('/messages')) return 'messages';
  if (path.includes('/responses')) return 'responses';
  if (path.includes('/chat/completions')) return 'chat-completions';
  if (path.includes('/completions')) return 'completions';
  if (path.includes('/v1beta/') || path.includes(':generateContent')) return 'gemini';
  return null;
};

export const collectByKind = (kind: CollectKind, events: readonly DumpStreamEvent[]): Promise<CollectOutcome<unknown>> => {
  switch (kind) {
  case 'completions':      return collectCompletionsStream(events);
  case 'chat-completions': return collectChatCompletionsStream(events);
  case 'messages':         return collectMessagesStream(events);
  case 'responses':        return collectResponsesStream(events);
  case 'gemini':           return collectGeminiStream(events);
  }
};

// Each protocol wrapper:
//   1. scans the stored frames upfront for terminal / error markers,
//      setting our own `truncated`/`error` signals
//   2. feeds the same frames into the protocol's pure reassembler
//   3. on a reassembler throw (missing terminal etc.), preserves our
//      detected signals — the throw is the very condition we already
//      flagged
//
// Error frames are filtered before the reassembler sees them; the
// reassemblers wrap upstream error events as "Upstream SSE error: ..."
// for the live path, which would clobber the raw message we surfaced.

// /v1/completions: no inline error envelope (errors surface as 4xx JSON or
// as truncation, not as event-stream-level error frames), so a `done` frame
// is the sole completion signal.
const collectCompletionsStream = async (events: readonly DumpStreamEvent[]): Promise<CollectOutcome<CompletionsResult>> => {
  let truncated = true;
  for (const ev of events) {
    if (ev.frame.type === 'done') { truncated = false; break; }
  }

  const eventStream = (async function* () {
    for (const ev of events) {
      const frame = ev.frame as ProtocolFrame<CompletionsStreamEvent>;
      if (frame.type === 'event') yield frame.event;
    }
  })();
  try {
    const result = await reassembleCompletionsEvents(eventStream);
    return { result, error: null, truncated };
  } catch (e) {
    return { result: null, error: e instanceof Error ? e.message : String(e), truncated: true };
  }
};

const collectChatCompletionsStream = async (events: readonly DumpStreamEvent[]): Promise<CollectOutcome<ChatCompletionsResult>> => {
  let truncated = true;
  let error: string | null = null;
  for (const ev of events) {
    const frame = ev.frame as ProtocolFrame<ChatCompletionsStreamEvent>;
    if (frame.type === 'done') { truncated = false; break; }
    if (frame.type === 'event') {
      const errorMsg = chatCompletionsErrorPayloadMessage(frame.event);
      if (errorMsg !== null) {
        error = errorMsg;
        break;
      }
    }
  }

  const eventStream = (async function* () {
    for (const ev of events) {
      const frame = ev.frame as ProtocolFrame<ChatCompletionsStreamEvent>;
      if (frame.type === 'event') yield frame.event;
    }
  })();
  try {
    const result = await reassembleChatCompletionsEvents(eventStream);
    return { result, error, truncated };
  } catch (e) {
    return { result: null, error: error ?? (e instanceof Error ? e.message : String(e)), truncated: true };
  }
};

const collectMessagesStream = async (events: readonly DumpStreamEvent[]): Promise<CollectOutcome<MessagesResult>> => {
  let truncated = true;
  let error: string | null = null;
  for (const ev of events) {
    const frame = ev.frame as ProtocolFrame<MessagesStreamEvent>;
    if (frame.type !== 'event') continue;
    if (frame.event.type === 'message_stop') { truncated = false; break; }
    if (frame.event.type === 'error') {
      error = frame.event.error.message;
      break;
    }
  }

  const eventStream = (async function* () {
    for (const ev of events) {
      const frame = ev.frame as ProtocolFrame<MessagesStreamEvent>;
      if (frame.type === 'event' && frame.event.type !== 'error') yield frame.event;
    }
  })();
  try {
    const result = await reassembleMessagesEvents(eventStream);
    return { result, error, truncated };
  } catch (e) {
    return { result: null, error: error ?? (e instanceof Error ? e.message : String(e)), truncated: true };
  }
};

const collectResponsesStream = async (events: readonly DumpStreamEvent[]): Promise<CollectOutcome<ResponsesResult>> => {
  let truncated = true;
  let error: string | null = null;
  for (const ev of events) {
    const frame = ev.frame as ProtocolFrame<ResponsesStreamEvent>;
    if (frame.type !== 'event') continue;
    if (frame.event.type === 'error') {
      error = frame.event.message;
      break;
    }
    if (frame.event.type === 'response.failed') {
      error = 'stream ended with response.failed event';
      break;
    }
    if (isResponsesTerminalEvent(frame.event)) { truncated = false; break; }
  }

  const eventStream = (async function* () {
    for (const ev of events) {
      const frame = ev.frame as ProtocolFrame<ResponsesStreamEvent>;
      if (frame.type === 'event' && frame.event.type !== 'error') yield frame.event;
    }
  })();
  try {
    const result = await reassembleResponsesEvents(eventStream);
    return { result, error, truncated };
  } catch (e) {
    return { result: null, error: error ?? (e instanceof Error ? e.message : String(e)), truncated: true };
  }
};

const collectGeminiStream = async (events: readonly DumpStreamEvent[]): Promise<CollectOutcome<GeminiResult>> => {
  let truncated = true;
  let error: string | null = null;
  for (const ev of events) {
    const frame = ev.frame as ProtocolFrame<GeminiStreamEvent>;
    if (frame.type === 'done') { truncated = false; break; }
    if (frame.type !== 'event') continue;
    if (isGeminiErrorEvent(frame.event)) {
      error = frame.event.error.message;
      break;
    }
    if (isGeminiTerminalEvent(frame.event)) { truncated = false; break; }
  }

  const frameStream = (async function* () {
    for (const ev of events) yield ev.frame as ProtocolFrame<GeminiStreamEvent>;
  })();
  try {
    const result = await collectGeminiProtocolEventsToResult(frameStream);
    return { result, error, truncated };
  } catch (e) {
    return { result: null, error: error ?? (e instanceof Error ? e.message : String(e)), truncated: true };
  }
};
