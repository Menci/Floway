import type { DumpCapture } from './types.ts';
import { encodeBodyForWire } from './wire.ts';
import { isReplayableBody, type Fetcher } from '@floway-dev/http';

const errorText = (error: unknown): string => error instanceof Error ? error.stack ?? error.message : String(error);

export class HttpCapture {
  readonly exchanges: DumpCapture['exchanges'] = [];

  wrapFetcher(fetcher: Fetcher, upstreamId: string): Fetcher {
    return async (url, init) => {
      const body = isReplayableBody(init.body) ? init.body.open() : init.body;
      const request = new Request(url, { ...init, body, duplex: 'half' } as RequestInit);
      const bytes = new Uint8Array(await request.arrayBuffer());
      const exchange: DumpCapture['exchanges'][number] = {
        upstreamId,
        request: {
          url,
          method: request.method,
          headers: [...request.headers],
          body: encodeBodyForWire(bytes, request.headers.get('content-type') ?? ''),
        },
        response: null,
        error: null,
      };
      this.exchanges.push(exchange);
      try {
        const response = await fetcher(url, { ...init, headers: request.headers, body: body == null ? null : bytes });
        const capture = new RawResponseCapture(response);
        Object.defineProperty(exchange, 'response', { enumerable: true, get: () => capture.snapshot() });
        return capture.wrap();
      } catch (error) {
        exchange.error = errorText(error);
        throw error;
      }
    };
  }
}

class RawResponseCapture {
  private readonly chunks: Uint8Array[] = [];
  private complete = false;
  private cancelled = false;
  private error: string | null = null;

  constructor(private readonly response: Response) {}

  snapshot(): NonNullable<DumpCapture['exchanges'][number]['response']> {
    const bytes = new Uint8Array(this.chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      status: this.response.status,
      headers: [...this.response.headers],
      body: encodeBodyForWire(bytes, this.response.headers.get('content-type') ?? ''),
      complete: this.complete,
      error: this.error,
    };
  }

  wrap(): Response {
    if (this.response.body === null) {
      this.complete = true;
      return this.response;
    }
    const reader = this.response.body.getReader();
    let released = false;
    const finish = () => {
      if (!released) { released = true; reader.releaseLock(); }
    };
    const stream = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          const { value, done } = await reader.read();
          if (this.cancelled) return;
          if (done) {
            this.complete = true;
            finish();
            controller.close();
          } else {
            this.chunks.push(value.slice());
            controller.enqueue(value);
          }
        } catch (error) {
          if (this.cancelled) return;
          this.error = errorText(error);
          finish();
          controller.error(error);
        }
      },
      cancel: async reason => {
        this.cancelled = true;
        if (reason !== undefined) this.error = errorText(reason);
        try { await reader.cancel(reason); } finally { finish(); }
      },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: this.response.status, statusText: this.response.statusText, headers: this.response.headers });
  }
}
