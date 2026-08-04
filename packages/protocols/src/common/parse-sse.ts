import { type SseFrame, sseFrame } from './sse.ts';

interface ParseSSEStreamOptions {
  signal?: AbortSignal;
}

interface SSEField {
  name: string;
  value: string;
}

// https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
// The space after an SSE field's first colon is optional. When present, only
// that one space is removed; every other character remains part of the value.
const parseSSEField = (line: string): SSEField => {
  const colonIndex = line.indexOf(':');
  if (colonIndex === -1) return { name: line, value: '' };

  const value = line.slice(colonIndex + 1);
  return {
    name: line.slice(0, colonIndex),
    value: value.startsWith(' ') ? value.slice(1) : value,
  };
};

export const parseSSEStream = async function* (body: ReadableStream<Uint8Array>, options: ParseSSEStreamOptions = {}): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const { signal } = options;
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let currentData: string[] = [];
  let cancelPromise: Promise<void> | undefined;

  const cancelReader = (reason?: unknown): Promise<void> => {
    cancelPromise ??= reader.cancel(reason).catch(() => {});
    return cancelPromise;
  };

  const cancelReaderOnAbort = () => {
    void cancelReader(signal?.reason);
  };

  const dispatchEvent = (): SseFrame | null => {
    const data = currentData.join('\n');
    currentData = [];
    const event = currentEvent;
    currentEvent = '';
    return data ? sseFrame(data, event || undefined) : null;
  };

  const readLine = (rawLine: string): SseFrame | null => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') return dispatchEvent();

    const { name, value } = parseSSEField(line);
    if (name === 'event') {
      currentEvent = value;
      return null;
    }

    if (name === 'data') {
      currentData.push(value);
    }

    return null;
  };

  if (signal?.aborted) {
    await cancelReader(signal.reason);
    return;
  }

  signal?.addEventListener('abort', cancelReaderOnAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (signal?.aborted) return;
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const frame = readLine(line);
        if (frame) yield frame;
      }
    }

    if (buffer) {
      const lines = buffer.split('\n');
      buffer = '';
      for (const line of lines) {
        const frame = readLine(line);
        if (frame) yield frame;
      }
    }

    const finalFrame = dispatchEvent();
    if (finalFrame) yield finalFrame;
  } finally {
    signal?.removeEventListener('abort', cancelReaderOnAbort);
    await (cancelPromise ?? reader.cancel());
  }
};
