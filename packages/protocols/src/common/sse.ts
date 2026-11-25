export interface SseFrame {
  type: 'sse';
  event?: string;
  data: string;
}

// Bytes written to the stream as they are, without SSE field framing, or read
// back from an upstream that wrote such a line. Some upstreams finish a stream
// with a bare JSON error body, which the SSE grammar does not claim; a reader
// that expects that body needs to see that it arrived unframed.
export interface SseRawFrame {
  type: 'sse-raw';
  data: string;
}

export interface SseCommentFrame {
  type: 'sse-comment';
  comment: string;
}

export interface EventFrame<TEvent> {
  type: 'event';
  event: TEvent;
}

export interface DoneFrame {
  type: 'done';
}

export type SseWritableFrame = SseFrame | SseCommentFrame | SseRawFrame;

// What a reader yields: the framed events, and any payload the stream carried
// without SSE framing.
export type SseReadableFrame = SseFrame | SseRawFrame;

export type ProtocolFrame<TEvent> = EventFrame<TEvent> | DoneFrame;

export interface SseErrorFrame {
  readonly type: 'error';
  readonly cause: { readonly message: string; readonly cause: unknown };
}

export type ParsedProtocolFrame<TEvent> = ProtocolFrame<TEvent> | SseErrorFrame;

export const sseFrame = (data: string, event?: string): SseFrame => ({
  type: 'sse',
  ...(event === undefined ? {} : { event }),
  data,
});

export const sseCommentFrame = (comment: string): SseCommentFrame => ({
  type: 'sse-comment',
  comment,
});

export const eventFrame = <TEvent>(event: TEvent): EventFrame<TEvent> => ({
  type: 'event',
  event,
});

export const doneFrame = (): DoneFrame => ({ type: 'done' });

export const sseRawFrame = (data: string): SseRawFrame => ({ type: 'sse-raw', data });
