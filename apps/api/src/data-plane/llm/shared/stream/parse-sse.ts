import { type SseFrame, sseFrame } from '@floway-dev/protocols/common';

interface ParseSSEStreamOptions {
  signal?: AbortSignal;
}

export const parseSSEStream = async function* (body: ReadableStream<Uint8Array>, options: ParseSSEStreamOptions = {}): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const { signal } = options;
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let cancelPromise: Promise<void> | undefined;

  const cancelReader = (reason?: unknown): Promise<void> => {
    cancelPromise ??= reader.cancel(reason).catch(() => {});
    return cancelPromise;
  };

  const cancelReaderOnAbort = () => {
    void cancelReader(signal?.reason);
  };

  const readLine = (rawLine: string): SseFrame | null => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
      return null;
    }

    if (line.startsWith('data: ')) {
      const frame = sseFrame(line.slice(6), currentEvent || undefined);
      currentEvent = '';
      return frame;
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
  } finally {
    signal?.removeEventListener('abort', cancelReaderOnAbort);
    await (cancelPromise ?? reader.cancel());
  }
};
