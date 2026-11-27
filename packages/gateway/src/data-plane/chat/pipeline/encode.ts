import type { GatewayDump } from '../../pipeline/services.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS, serializeSseFrame } from '../../shared/sse.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import { firstOutputTokenSignal } from '../shared/first-output-token.ts';
import { filterHeaders, getHeader, setHeader, type HttpHeaders, type HttpResponseFact, type HttpStreamError } from '@floway-dev/http';
import type { ManagedStream, Result } from '@floway-dev/pipeline';
import { eventFrame, sseCommentFrame, type ProtocolFrame, type SseWritableFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ProtocolError, ProtocolStreamError } from '@floway-dev/upstream';

const encoder = new TextEncoder();

export const localChatHead = (status: number): HttpResponseFact => ({ status, statusText: '', headers: [], body: null });

const allowsBody = (status: number): boolean => status !== 204 && status !== 205 && status !== 304;

const encodedChatResponse = (http: HttpResponseFact, body: HttpResponseFact['body'], contentType: string): HttpResponseFact => ({
  ...http,
  headers: setHeader(filterHeaders(http.headers, isForwardableUpstreamHeader), 'content-type', contentType),
  body,
});

export const chatJsonContentType = (headers: HttpHeaders): string => {
  const upstreamType = getHeader(headers, 'content-type');
  const knownJson = typeof upstreamType === 'string' && /^application\/(?:[!#$%&'*+.^_`|~0-9a-z-]+\+)?json\s*(?:;|$)/i.test(upstreamType);
  return knownJson ? upstreamType : 'application/json';
};

export const jsonChatResponse = (http: HttpResponseFact, value: unknown): HttpResponseFact =>
  encodedChatResponse(http, allowsBody(http.status) ? encoder.encode(JSON.stringify(value)) : null, chatJsonContentType(http.headers));

export const recordChatError = (dump: GatewayDump | null, error: ProtocolError, candidate?: { upstreamId: string }): void => {
  dump?.error(error.source === 'upstream' ? 'upstream' : 'gateway', candidate?.upstreamId);
};

export const captureChatFrame = (dump: GatewayDump | null, protocol: ChatTargetApi, startedAt: number | undefined) => {
  if (dump === null) return undefined;
  let observedOutput = false;
  return (frame: ProtocolFrame<unknown>): void => {
    if (!observedOutput && startedAt !== undefined && firstOutputTokenSignal(frame, protocol) !== null) {
      dump.firstOutput(startedAt);
      observedOutput = true;
    }
    dump.frame(frame);
  };
};

type Source<Event> = ManagedStream<Event, ProtocolStreamError>;
type ByteStream = ManagedStream<Uint8Array, HttpStreamError>;

interface ByteProducer<Event> {
  read(source: Source<Event>): AsyncIterableIterator<Result<Event, ProtocolStreamError>>;
  discard(source: Source<Event>): void;
  readonly services: { readonly dump: GatewayDump | null };
}

interface EncodeScope<Event> {
  discard(source: Source<Event>): void;
  wrapStream(
    source: Source<Event>,
    produce: (source: Source<Event>, scope: ByteProducer<Event>) => AsyncGenerator<Result<Uint8Array, HttpStreamError>, void, unknown>,
  ): ByteStream;
}

export interface StreamFrame {
  readonly wire: SseWritableFrame;
  readonly frame?: ProtocolFrame<unknown>;
}

export const clientFrame = (event: unknown, wire: SseWritableFrame): StreamFrame => ({ frame: eventFrame(event), wire });

interface ChatSseOptions<Event> {
  protocol: ChatTargetApi;
  event(event: Event): StreamFrame | null;
  error(error: ProtocolStreamError): readonly StreamFrame[];
  done?(): readonly StreamFrame[];
  keepAlive?: SseWritableFrame;
  headers?: HttpHeaders;
}

type Read<Event> =
  | { kind: 'item'; item: IteratorResult<Result<Event, ProtocolStreamError>> }
  | { kind: 'panic'; error: unknown };

export const chatSse = <Event>(
  head: HttpResponseFact,
  source: Source<Event>,
  scope: EncodeScope<NoInfer<Event>>,
  options: ChatSseOptions<NoInfer<Event>>,
): HttpResponseFact => {
  let headers = setHeader(head.headers, 'cache-control', 'no-cache');
  headers = setHeader(headers, 'x-accel-buffering', 'no');
  for (const [name, value] of options.headers ?? []) headers = setHeader(headers, name, value);

  const response = { ...head, headers };
  if (!allowsBody(head.status)) {
    scope.discard(source);
    return encodedChatResponse(response, null, 'text/event-stream');
  }

  const keepAlive = encoder.encode(serializeSseFrame(options.keepAlive ?? sseCommentFrame('keepalive')));
  const body = scope.wrapStream(source, async function* (inner, producer) {
    const cursor = producer.read(inner);
    const capture = captureChatFrame(producer.services.dump, options.protocol, head.startedAt);
    const encode = ({ wire, frame }: StreamFrame): Result<Uint8Array, HttpStreamError> => {
      if (frame !== undefined) capture?.(frame);
      return { ok: true, value: encoder.encode(serializeSseFrame(wire)) };
    };

    while (true) {
      const read: { result?: Read<Event>; wake?: () => void } = {};
      const ready = (result: Read<Event>): void => {
        read.result = result;
        read.wake?.();
      };
      // Keep exactly one cursor read pending across every heartbeat.
      void cursor.next().then(item => ready({ kind: 'item', item }), error => ready({ kind: 'panic', error }));
      while (read.result === undefined) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS);
          read.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        delete read.wake;
        if (read.result === undefined) yield { ok: true, value: keepAlive };
      }

      const { result } = read;
      if (result.kind === 'panic') throw result.error;
      if (result.item.done) {
        for (const frame of options.done?.() ?? []) yield encode(frame);
        return;
      }
      const item = result.item.value;
      if (!item.ok) {
        producer.discard(inner);
        if (item.error.kind !== 'abort') {
          producer.services.dump?.failed(item.error.cause);
          for (const frame of options.error(item.error)) yield encode(frame);
        }
        return;
      }
      const frame = options.event(item.value);
      if (frame !== null) yield encode(frame);
    }
  });
  return encodedChatResponse(response, body, 'text/event-stream');
};
