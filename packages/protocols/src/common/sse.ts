export interface SseFrame {
  type: 'sse';
  event?: string;
  data: string;
}

export interface SseTrailerFrame {
  type: 'sse-trailer';
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

export type SseWritableFrame = SseFrame | SseCommentFrame | SseTrailerFrame;

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

export const sseTrailerFrame = (data: string): SseTrailerFrame => ({ type: 'sse-trailer', data });
