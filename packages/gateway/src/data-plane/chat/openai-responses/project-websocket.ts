import type { Fields, OpenAIResponsesServeEntry, OpenAIResponsesServeExit } from './facts.ts';
import { recordStream, streamReferenceOf } from '../../../dump/run-sink.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS } from '../../shared/sse.ts';
import type { ChatServices } from '../services.ts';
import { bindClientRelease, withClientVerdict } from '../shared/client-stream.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE, isOpenAIResponsesTerminalEvent, type ClientOpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { toInternalDebugError } from '@floway-dev/provider';

// Our implementor slug prefixes the keep-alive's wire type; the spec reserves
// every unprefixed type for itself, gives `acme:trace_event` as the form, and
// makes `type` and `sequence_number` the only mandatory fields — which is all
// this frame carries.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L758-L765
// A slug type is inert in openai-node's WebSocket reader: the frame is emitted
// under its own literal type name, nothing is listening on that name, and only
// a frame typed `error` is routed into the socket's error path.
// https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/resources/responses/ws-base.ts#L346-L371
export const KEEP_ALIVE_EVENT_TYPE = 'floway:keep_alive';

// Extended reasoning turns go completely silent: upstream sends SSE
// `ping` events, `parseOpenAIResponsesStream` drops them, and no frame at
// all reaches this socket for minutes. A silent Workers WebSocket
// does not reliably survive that. Cloudflare states the
// teardown without naming a duration — "when no data is transmitted
// in either direction for a period of time" — and probing a
// `workers.dev` endpoint built on this handler's own `WebSocketPair`
// shape found no constant to design against: from one vantage point
// an idle socket lived a full hour, 4/4, while from another 13 of 16
// idle sockets died between 215.8 s and 1788.2 s, median around
// 660 s. Teardown is path-dependent and stochastic, and it is always
// a silent EOF — across roughly 40 observed teardowns, not one CLOSE
// frame and not one RST, so the failure carries no protocol-level
// signal.
// https://developers.cloudflare.com/network/websockets/#idle-timeout
//
// Cloudflare's stated remedy, a client-side ping/pong heartbeat,
// does not cover it: on the path that drops, 6 of 9 sockets pinging
// every 30 s died anyway, one of them after 61.5 s. A
// server-originated text frame did cover it — 12/12 survived on that
// same path, with ≤400 s intervals holding and ≥500 s failing. Why a
// data frame outlives a protocol ping there was not established.
// Sending a ping is not open to us regardless: workerd's `WebSocket`
// exposes only accept/send/close/(de)serializeAttachment, and the kj
// layer beneath states the omission as a design decision ("Ping/Pong
// … are not exposed through this interface"). RFC 6455 §5.5.2 is the
// right mechanism, it is unreachable here, and it would not help the
// client that needs it most either, since Codex's frame pump
// swallows control frames and only a text frame rearms its 300 s
// idle timeout.
// https://github.com/cloudflare/workerd/blob/26b5461b7dcc640bb16072f1ba6f2c6df82572ba/src/workerd/api/web-socket.h#L346-L394
// https://github.com/capnproto/capnproto/blob/e9fa5c7dc98192fc0dc0098ec770db68f997a938/c%2B%2B/src/kj/compat/http.h#L622-L631
// https://github.com/openai/codex/blob/e6cfd40c3f444aadd6017c9eeab01db70f48961a/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L91-L101
// https://github.com/openai/codex/blob/e6cfd40c3f444aadd6017c9eeab01db70f48961a/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L695-L699
// https://github.com/openai/codex/blob/e6cfd40c3f444aadd6017c9eeab01db70f48961a/codex-rs/model-provider-info/src/lib.rs#L26
//
// So the keep-alive is a text frame whose `type` no client
// recognizes. The spec's extension section governs its shape: an
// implementor slug prefix plus a `sequence_number`. A keep-alive is
// neither a delta nor a state-machine event, so it cannot be spelled
// as a `response.*` event; the slug form is what makes it ignorable
// without loss. openai-node's SSE `responses.stream()` helper is the
// one client that treats a prefixed type as fatal — its accumulator
// closes its `switch` on `assertNever` — and it is out of reach here:
// Floway's SSE keep-alive is a comment line, and this frame exists
// only on the WebSocket transport.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L758
// https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/lib/responses/ResponseAccumulator.ts#L387-L389
//
// Held back until the turn's first event has gone out. That gate is
// parity with the stricter transport, not a demand of this one: both
// SDKs' SSE stream helpers refuse anything before `response.created`
// — openai-node rejects even its own `keepalive` type there — while
// every WebSocket reader we can inspect tolerates an unknown type at
// any position, openai-node emitting it under a name nothing listens
// on, openai-python constructing it unchecked, and Codex tracing and
// discarding it. The window before the first event therefore stays
// unprotected, and closing it is a behavior question rather than a
// client-compatibility one.
// https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/lib/responses/ResponseAccumulator.ts#L25-L31
// https://github.com/openai/openai-python/blob/3844843c277f42b0b18beaa58152cfda61df524a/src/openai/lib/streaming/responses/_responses.py#L369-L370
// https://github.com/openai/openai-python/blob/3844843c277f42b0b18beaa58152cfda61df524a/src/openai/resources/responses/responses.py#L4493-L4502
// https://github.com/openai/codex/blob/e6cfd40c3f444aadd6017c9eeab01db70f48961a/codex-rs/codex-api/src/sse/responses.rs#L466-L472

export interface OpenAIResponsesWebSocketPacket {
  readonly text: string;
  readonly frame: ProtocolFrame<Record<string, unknown>> | null;
}

export type OpenAIResponsesWebSocketEntry = OpenAIResponsesServeEntry & {
  readonly 'ingress.chat.openaiResponses.eventId': string | undefined;
};
export type OpenAIResponsesWebSocketExit = Omit<OpenAIResponsesServeExit, 'response.chat.openaiResponses.rendered' | 'response.http.jsonBody'> & {
  readonly 'response.chat.openaiResponses.websocket': AsyncIterable<OpenAIResponsesWebSocketPacket>;
};

export const projectOpenAIResponsesWebSocket = defineStage<
  Pick<OpenAIResponsesWebSocketEntry, 'ingress.chat.openaiResponses.eventId'>,
  Pick<OpenAIResponsesWebSocketEntry, 'ingress.chat.openaiResponses.eventId'>,
  Fields<'response.chat.openaiResponses.rendered' | 'response.chat.openaiResponses.streamedUsage' | 'response.http.status' | 'response.chat.clientFrames'> & Pick<OpenAIResponsesWebSocketEntry, 'ingress.chat.openaiResponses.eventId'>,
  Pick<OpenAIResponsesWebSocketExit, 'response.chat.openaiResponses.websocket'> & Fields<'response.chat.openaiResponses.streamedUsage' | 'response.chat.clientFrames'>,
  ChatServices
>({
  name: 'projectOpenAIResponsesWebSocket',
  through: {
    request: { needs: ['ingress.chat.openaiResponses.eventId'], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.openaiResponses.rendered', 'response.chat.openaiResponses.streamedUsage', 'response.http.status', 'response.chat.clientFrames'],
      consumes: ['response.chat.openaiResponses.rendered', 'response.chat.clientFrames', 'response.chat.openaiResponses.streamedUsage'],
      provides: ['response.chat.openaiResponses.websocket', 'response.chat.clientFrames', 'response.chat.openaiResponses.streamedUsage'],
    },
  },
  execute: async (facts, next, use) => {
    const back = await next(facts);
    const { 'response.chat.openaiResponses.rendered': rendered, ...rest } = back;
    const eventId = back['ingress.chat.openaiResponses.eventId'];
    let started = false;
    const verdict = Promise.withResolvers<boolean>();
    const packet = (event: Record<string, unknown>, recorded = true): OpenAIResponsesWebSocketPacket => {
      const payload = eventId === undefined ? event : { ...event, event_id: eventId };
      const text = JSON.stringify(payload);
      return { text, frame: recorded ? eventFrame(payload) : null };
    };
    const generator = (async function* () {
      started = true;
      let completed = false;
      let failed = false;
      try {
        if (!(Symbol.asyncIterator in rendered)) {
          failed = true;
          yield packet({ type: 'error', status: back['response.http.status'], error: normalizeErrorBody(rendered, back['response.http.status']) });
        } else {
          const iterator = (rendered as AsyncIterable<ProtocolFrame<ClientOpenAIResponsesStreamEvent>>)[Symbol.asyncIterator]();
          const sequence = createDownstreamSequence();
          let pendingNext = pendingWsFrameResult(iterator.next());
          let terminalEvent: ClientOpenAIResponsesStreamEvent | undefined;
          let streamed = false;
          let exhausted = false;
          try {
            while (true) {
              if (use.gateway.abortSignal?.aborted) return;
              const next = await nextFrameOrKeepAlive(pendingNext);
              if (next.type === 'keep-alive') {
                if (!streamed) continue;
                yield packet({ type: KEEP_ALIVE_EVENT_TYPE, sequence_number: sequence.take() }, false);
                continue;
              }
              if (next.type === 'next-error') throw next.error;
              if (next.result.done) { exhausted = true; break; }
              const frame = next.result.value;
              pendingNext = pendingWsFrameResult(iterator.next());
              if (frame.type !== 'event' || terminalEvent !== undefined) continue;
              const event = frame.event;
              if (event.type === 'error' || event.type === 'response.failed') failed = true;
              // A terminal follows committed item/snapshot writes. Hold it until source
              // exhaustion, so a follow-up starts only after all work behind it completed.
              if (isOpenAIResponsesTerminalEvent(event)) { terminalEvent = event; continue; }
              yield packet(sequence.renumber(event) as unknown as Record<string, unknown>);
              streamed = true;
            }
          } finally {
            if (!exhausted) await iterator.return?.();
          }
          if (terminalEvent === undefined) throw new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE);
          yield packet(sequence.renumber(terminalEvent) as unknown as Record<string, unknown>);
        }
        completed = true;
      } catch (error) {
        failed = true;
        use.gateway.dump?.failed(error);
        if (!use.gateway.abortSignal?.aborted) yield packet({ type: 'error', status: 500, error: { ...toInternalDebugError(error), code: 'internal_error' } });
        completed = true;
      } finally {
        verdict.resolve(failed || !completed);
      }
    })();
    const packets = recordStream({ [Symbol.asyncIterator]: () => generator }, use.gateway.dump, value => value.frame);
    const reference = streamReferenceOf(packets);
    bindClientRelease(back, async () => {
      if (!started) verdict.resolve(true);
      await generator.return();
    });
    return {
      ...rest,
      'response.chat.openaiResponses.websocket': move(packets),
      'response.chat.clientFrames': move({ ...reference, async *[Symbol.asyncIterator]() { for await (const value of packets) if (value.frame !== null) yield value.frame; } }),
      'response.chat.openaiResponses.streamedUsage': move(withClientVerdict(back['response.chat.openaiResponses.streamedUsage'], verdict.promise)),
    };
  },
});

type WsFrameRaceResult =
  | { type: 'frame'; result: IteratorResult<ProtocolFrame<ClientOpenAIResponsesStreamEvent>> }
  | { type: 'next-error'; error: unknown }
  | { type: 'keep-alive' };

const pendingWsFrameResult = (pendingNext: Promise<IteratorResult<ProtocolFrame<ClientOpenAIResponsesStreamEvent>>>): Promise<WsFrameRaceResult> =>
  pendingNext.then(
    (result): WsFrameRaceResult => ({ type: 'frame', result }),
    (error): WsFrameRaceResult => ({ type: 'next-error', error }),
  );

// The interval is the one already shared with SSE rather than a WebSocket
// constant of its own. Widening the gap between server data frames on a
// dropping path put the boundary between 400 s, which still held the socket
// open, and 500 s, which did not, so 15 s is far more frequent than the
// mechanism needs. It is kept because widening it buys nothing: a keep-alive
// is ~70 bytes, and the earliest unprotected idle teardown seen on that same
// path was 215.8 s, so an interval chosen for economy would spend a real
// margin against a stochastic teardown to save nothing.
const nextFrameOrKeepAlive = async (pendingFrame: Promise<WsFrameRaceResult>): Promise<WsFrameRaceResult> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const keepAlive = new Promise<WsFrameRaceResult>(resolve => {
    timeoutId = setTimeout(() => resolve({ type: 'keep-alive' }), DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS);
  });
  try {
    return await Promise.race([pendingFrame, keepAlive]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

interface DownstreamSequence {
  renumber(event: ClientOpenAIResponsesStreamEvent): ClientOpenAIResponsesStreamEvent;
  take(): number;
}

// A WebSocket turn shares one sequence space with the streaming-HTTP events it
// carries, so a keep-alive cannot sit outside that numbering: it takes a real
// slot and every later event is shifted past it. The number is always present
// and always numeric, because a resuming openai-python client compares it with
// `>` against its `starting_after` cursor and `None` there raises a TypeError.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L117
// https://github.com/openai/openai-python/blob/3844843c277f42b0b18beaa58152cfda61df524a/src/openai/lib/streaming/responses/_responses.py#L59
//
// Upstream numbering is left untouched until the first keep-alive, and a
// keep-alive can only follow an event that already went out, so the slot it
// takes is always known.
const createDownstreamSequence = (): DownstreamSequence => {
  let shift = 0;
  let next = 0;
  return {
    renumber: event => {
      if (event.sequence_number === undefined) return event;
      const sequenceNumber = event.sequence_number + shift;
      next = sequenceNumber + 1;
      return { ...event, sequence_number: sequenceNumber };
    },
    take: () => {
      shift += 1;
      const taken = next;
      next += 1;
      return taken;
    },
  };
};

const normalizeErrorBody = (body: unknown, status: number): Record<string, unknown> => {
  const source = body && typeof body === 'object' && 'error' in body && typeof (body as { error?: unknown }).error === 'object'
    ? (body as { error: Record<string, unknown> }).error
    : body && typeof body === 'object'
      ? body as Record<string, unknown>
      : {};
  const type = typeof source.type === 'string'
    ? source.type
    : status >= 500 ? 'server_error' : 'invalid_request_error';
  const message = typeof source.message === 'string'
    ? source.message
    : `OpenAI Responses request failed with status ${status}.`;
  return {
    ...source,
    type,
    code: typeof source.code === 'string' ? source.code : type,
    message,
  };
};
