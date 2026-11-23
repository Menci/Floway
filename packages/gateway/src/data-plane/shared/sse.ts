import type { SseWritableFrame } from '@floway-dev/protocols/common';

export const DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS = 15_000;

interface SseFinished {
  type: 'completed' | 'protocol-error';
  trailer?: readonly string[];
}

type SseEnd = SseFinished | { type: 'premature-eof'; error: Error };

export interface SseProtocol<T> {
  encode: (input: T) => { wire: string | null; end?: SseEnd };
  eof: (contentComplete?: boolean) => SseEnd;
  failure: (error: unknown) => readonly [string, ...string[]];
}

export const serializeSseFrame = (frame: SseWritableFrame): string => {
  if (frame.type === 'sse-raw') return frame.data;
  if (frame.type === 'sse-comment') {
    return `${frame.comment.split(/\r\n|\r|\n/).map(line => `: ${line}`).join('\n')}\n\n`;
  }
  if (frame.event !== undefined && /[\r\n]/.test(frame.event)) {
    throw new Error('SSE event name cannot contain CR or LF');
  }
  const event = frame.event ? `event: ${frame.event}\n` : '';
  const data = frame.data.split(/\r\n|\r|\n/).map(line => `data: ${line}`).join('\n');
  return `${event}${data}\n\n`;
};
