import { openaiInternalErrorPayload } from './openai-errors.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS, serializeSseFrame } from './sse.ts';
import type { EncoderScope } from '../pipeline/encode-response.ts';
import { setHeader, type HttpResponseFact } from '@floway-dev/http';
import type { ManagedStream, Result } from '@floway-dev/pipeline';
import { isOpenAIErrorPayload, sseCommentFrame, sseFrame, type SseWritableFrame } from '@floway-dev/protocols/common';
import { toInternalDebugError, type ProtocolStreamError } from '@floway-dev/provider';

const encoder = new TextEncoder();
const frameBytes = (frame: SseWritableFrame): Uint8Array => encoder.encode(serializeSseFrame(frame));
const defaultKeepAlive = sseCommentFrame('keepalive');

const openAIErrorFrame = ({ cause }: ProtocolStreamError) => {
  const parsed = cause instanceof Error ? cause.cause : cause;
  const error = isOpenAIErrorPayload(parsed) ? parsed : openaiInternalErrorPayload(toInternalDebugError(cause));
  return sseFrame(JSON.stringify(error));
};

interface ProtocolSsePolicy<Event> {
  readonly errorFrame?: (error: ProtocolStreamError) => SseWritableFrame;
  readonly keepAlive?: SseWritableFrame;
  readonly terminal?: (event: Event) => boolean;
  readonly eof?: () => ProtocolStreamError | undefined;
}

const readWithKeepAlive = async function* <Item>(iterator: AsyncIterator<Item>, signal: AbortSignal) {
  type Next = Result<IteratorResult<Item>, unknown>;
  for (;;) {
    let result: Next | undefined;
    let wake: (() => void) | undefined;
    const resolve = (next: Next) => {
      result = next;
      wake?.();
    };
    void iterator.next().then(
      value => { resolve({ ok: true, value }); },
      error => { resolve({ ok: false, error }); },
    );
    while (result === undefined) {
      await new Promise<void>(ready => {
        const timer = setTimeout(ready, DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS);
        wake = () => {
          clearTimeout(timer);
          ready();
        };
      });
      wake = undefined;
      if (result === undefined && !signal.aborted) yield { kind: 'keepalive' } as const;
    }

    const next: Next = result;
    if (!next.ok) throw next.error;
    if (next.value.done) return;
    yield { kind: 'item', value: next.value.value } as const;
  }
};

export const encodeProtocolSse = <Event>(
  http: HttpResponseFact,
  stream: ManagedStream<Event, ProtocolStreamError>,
  scope: EncoderScope,
  frame: (event: Event) => SseWritableFrame | null,
  trailer?: SseWritableFrame,
  { errorFrame = openAIErrorFrame, keepAlive = defaultKeepAlive, terminal, eof }: ProtocolSsePolicy<Event> = {},
): HttpResponseFact => ({
  ...http,
  headers: setHeader(setHeader(http.headers, 'content-type', 'text/event-stream'), 'cache-control', 'no-cache'),
  body: scope.wrapStream(stream, async function* (items, { signal, abort }) {
    let ended = false;
    const heartbeat = frameBytes(keepAlive);
    for await (const item of readWithKeepAlive(items[Symbol.asyncIterator](), signal)) {
      if (ended || signal.aborted) continue;
      if (item.kind === 'keepalive') {
        yield { ok: true, value: heartbeat };
        continue;
      }

      const event = item.value;
      if (!event.ok) {
        ended = true;
        abort();
        if (event.error.kind !== 'abort') yield { ok: true, value: frameBytes(errorFrame(event.error)) };
      } else {
        const output = frame(event.value);
        if (terminal?.(event.value) === true) {
          ended = true;
          abort();
        }
        if (output !== null) yield { ok: true, value: frameBytes(output) };
      }
    }
    if (ended || signal.aborted) return;
    const failure = eof?.();
    if (failure !== undefined) yield { ok: true, value: frameBytes(errorFrame(failure)) };
    else if (trailer !== undefined) yield { ok: true, value: frameBytes(trailer) };
  }),
});
