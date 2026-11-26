import { encodedResponse, type EncoderScope } from '../../pipeline/encode.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS, serializeSseFrame } from '../../shared/sse.ts';
import { setHeader, type HttpHeaders, type HttpResponseFact } from '@floway-dev/http';
import type { ManagedStream, Result } from '@floway-dev/pipeline';
import { sseCommentFrame, type SseWritableFrame } from '@floway-dev/protocols/common';
import type { ProtocolStreamError } from '@floway-dev/provider';

type SseFrames = SseWritableFrame | readonly SseWritableFrame[] | null;

interface ChatSseOptions<Event> {
  event(event: Event): SseFrames;
  error(error: ProtocolStreamError): SseFrames;
  done?: SseFrames | (() => SseFrames);
  keepAlive?: SseWritableFrame;
  headers?: HttpHeaders;
}

const encoder = new TextEncoder();
const bytes = (frame: SseWritableFrame): Uint8Array => encoder.encode(serializeSseFrame(frame));
const isFrameArray = (frames: NonNullable<SseFrames>): frames is readonly SseWritableFrame[] => Array.isArray(frames);

const encodeFrames = function* (frames: SseFrames): Generator<{ ok: true; value: Uint8Array }> {
  if (frames === null) return;
  for (const frame of isFrameArray(frames) ? frames : [frames]) yield { ok: true, value: bytes(frame) };
};

type Read<Event> =
  | { kind: 'item'; item: IteratorResult<Result<Event, ProtocolStreamError>> }
  | { kind: 'panic'; error: unknown };

export const chatSse = <Event>(
  head: Omit<HttpResponseFact, 'body'>,
  source: ManagedStream<Event, ProtocolStreamError>,
  scope: EncoderScope,
  options: ChatSseOptions<Event>,
): HttpResponseFact => {
  const contentType = 'text/event-stream';
  let headers = setHeader(head.headers, 'cache-control', 'no-cache');
  headers = setHeader(headers, 'x-accel-buffering', 'no');
  for (const [name, value] of options.headers ?? []) headers = setHeader(headers, name, value);

  const response = { ...head, headers };
  if (head.status === 204 || head.status === 205 || head.status === 304) {
    scope.discard(source);
    return encodedResponse(response, null, contentType);
  }

  const keepAlive = bytes(options.keepAlive ?? sseCommentFrame('keepalive'));
  const body = scope.wrapStream(source, async function* (inner, producer) {
    const cursor = producer.read(inner);
    for (;;) {
      let read: Read<Event> | undefined;
      let wake: (() => void) | undefined;
      const ready = (result: Read<Event>): void => {
        read = result;
        wake?.();
      };
      // One next() and one handler pair remain pending across any number of heartbeats.
      void cursor.next().then(item => ready({ kind: 'item', item }), error => ready({ kind: 'panic', error }));
      while (read === undefined) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
        if (read === undefined) yield { ok: true, value: keepAlive };
      }

      const result = read as Read<Event>;
      if (result.kind === 'panic') throw result.error;
      if (result.item.done) {
        const { done } = options;
        if (done !== undefined) yield* encodeFrames(typeof done === 'function' ? done() : done);
        return;
      }
      if (!result.item.value.ok) {
        producer.discard(inner);
        yield* encodeFrames(options.error(result.item.value.error));
        return;
      }
      yield* encodeFrames(options.event(result.item.value.value));
    }
  });
  return encodedResponse(response, body, contentType);
};
