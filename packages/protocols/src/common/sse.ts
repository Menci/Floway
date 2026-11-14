export interface SseFrame {
  type: 'sse';
  event?: string;
  data: string;
}

// Bytes written to the stream as they are, without SSE field framing.
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

export type ProtocolFrame<TEvent> = EventFrame<TEvent> | DoneFrame;

export const sseFrame = (data: string, event?: string): SseFrame => ({
  type: 'sse',
  event,
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
