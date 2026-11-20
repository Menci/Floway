import type { LogStream, LogStreamStore } from '@floway-dev/platform';

export const testLogStreamStore = (): LogStreamStore => {
  const streams = new Map<string, LogStream>();
  return {
    async open(id) {
      const chunks: { offset: number; bytes: Uint8Array }[] = [];
      let length = 0;
      let ended = false;
      const listeners = new Set<() => void>();
      const wake = () => { for (const listener of listeners) listener(); };
      const stream: LogStream = {
        async append(offset, bytes) {
          if (ended) throw new Error('Test LogStream is ended');
          if (offset > length) throw new Error('Test LogStream append would leave a hole');
          const tail = bytes.slice(length - offset);
          if (tail.byteLength > 0) { chunks.push({ offset: length, bytes: tail }); length += tail.byteLength; }
          wake();
        },
        async end() { ended = true; wake(); },
        async *read(offset, signal) {
          while (!signal.aborted) {
            const chunk = chunks.find(chunk => chunk.offset + chunk.bytes.byteLength > offset);
            if (chunk) {
              const bytes = chunk.bytes.slice(Math.max(0, offset - chunk.offset));
              offset += bytes.byteLength;
              yield bytes;
            } else if (ended) return;
            else await new Promise<void>(resolve => {
              const finish = () => { listeners.delete(finish); signal.removeEventListener('abort', finish); resolve(); };
              listeners.add(finish);
              signal.addEventListener('abort', finish, { once: true });
            });
          }
          signal.throwIfAborted();
        },
      };
      streams.set(id, stream);
      return stream;
    },
    async get(id) { return streams.get(id) ?? null; },
  };
};
