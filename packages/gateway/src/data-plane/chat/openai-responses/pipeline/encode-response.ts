import type { OpenAIResponsesAction } from './facts.ts';
import { renderJsonResult, type ProtocolRenderer } from '../../../pipeline/encode-response.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS, serializeSseFrame } from '../../../shared/sse.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE } from '../response-headers.ts';
import { setHeader } from '@floway-dev/http';
import { eventFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import {
  isOpenAIResponsesErrorEvent,
  isOpenAIResponsesTerminalEvent,
  OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE,
  openaiResponsesProtocolFrameToSSEFrame,
  type OpenAIResponsesErrorEx,
  type OpenAIResponsesResultEx,
  type OpenAIResponsesStreamEventEx,
} from '@floway-dev/protocols/openai-responses';
import { internalDebugErrorFields, toInternalDebugError } from '@floway-dev/provider';

const utf8 = new TextEncoder();
const done = utf8.encode(serializeSseFrame(sseFrame('[DONE]')));
const keepAlive = utf8.encode(serializeSseFrame(sseCommentFrame('keepalive')));
const bytes = (event: OpenAIResponsesStreamEventEx) =>
  utf8.encode(serializeSseFrame(openaiResponsesProtocolFrameToSSEFrame(eventFrame(event))));

export const renderOpenAIResponses = (action: OpenAIResponsesAction): ProtocolRenderer<'response.openaiResponses'> => (outcome, http, delivery, scope) => {
  if (delivery.kind !== 'openaiResponses') throw new TypeError('OpenAI Responses encoder requires Responses delivery');
  if (action === 'generate') http = {
    ...http,
    headers: setHeader(http.headers, OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE),
  };
  if (outcome.kind === 'result') return renderJsonResult(outcome, http);
  if (action !== 'generate') throw new TypeError('OpenAI Responses compact requires scalar delivery');
  if (!delivery.stream) throw new TypeError('OpenAI Responses JSON delivery requires a collected response');
  return {
    ...http,
    headers: setHeader(setHeader(http.headers, 'content-type', 'text/event-stream'), 'cache-control', 'no-cache'),
    body: scope.wrapStream(outcome.stream, async function* (items, { signal, abort }) {
      let announced: OpenAIResponsesResultEx | undefined;
      let upstreamFailure: OpenAIResponsesErrorEx | undefined;
      const completedItems = new Map<number, OpenAIResponsesResultEx['output'][number]>();
      let sequence = 0;
      let terminal = false;
      const cursor = items[Symbol.asyncIterator]();
      const readFailure = (cause: unknown): Uint8Array => {
        const debug = toInternalDebugError(cause);
        const failure = { code: debug.type, message: debug.message, provider_specific_fields: internalDebugErrorFields(debug) };
        upstreamFailure = failure;
        return bytes({ type: 'error', sequence_number: sequence++, ...failure, param: null, error: failure });
      };

      for await (const read of readWithKeepAlive(cursor, signal)) {
        if (signal.aborted) continue;
        if (read.kind === 'keepalive') {
          yield { ok: true, value: keepAlive };
          continue;
        }
        if (!read.item.ok) {
          if (read.item.error.kind !== 'abort' && upstreamFailure === undefined) {
            yield { ok: true, value: readFailure(read.item.error.cause) };
          }
          continue;
        }

        const source = read.item.value;
        const event = { ...source, sequence_number: source.sequence_number ?? sequence };
        sequence = Math.max(sequence, event.sequence_number + 1);
        if ('response' in event) announced = event.response;
        if (event.type === 'response.output_item.done') completedItems.set(event.output_index, event.item);
        if (isOpenAIResponsesErrorEvent(event)) {
          const { type: _type, sequence_number: _sequence, ...fields } = event;
          const error = 'error' in fields ? fields.error : fields;
          upstreamFailure = { ...error, code: error.code ?? 'server_error' };
        }
        yield { ok: true, value: bytes(event) };
        if (isOpenAIResponsesTerminalEvent(event)) {
          terminal = true;
          abort();
          break;
        }
      }

      if (terminal || !signal.aborted) {
        if (!terminal) {
          if (upstreamFailure === undefined) {
            yield { ok: true, value: readFailure(new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE)) };
          }
          if (announced !== undefined && upstreamFailure !== undefined) {
            // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L419-L444
            const output = [...completedItems].sort(([left], [right]) => left - right).map(([, item]) => item);
            yield {
              ok: true,
              value: bytes({
                type: 'response.failed',
                sequence_number: sequence++,
                response: { ...announced, status: 'failed', output, incomplete_details: null, error: upstreamFailure },
              }),
            };
          }
        }
        yield { ok: true, value: done };
      }
      if (terminal) while (!(await cursor.next()).done) {
        // The delivered response is terminal. The subtree still owns settlement.
      }
    }),
  };
};

const readWithKeepAlive = async function* <Item>(iterator: AsyncIterator<Item>, signal: AbortSignal) {
  for (;;) {
    let timer: ReturnType<typeof setTimeout>;
    const pending = Promise.resolve(iterator.next()).then(result => ({ kind: 'result', result } as const));
    for (;;) {
      const tick = new Promise<{ readonly kind: 'keepalive' }>(resolve => {
        timer = setTimeout(() => { resolve({ kind: 'keepalive' }); }, DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS);
      });
      const read = await Promise.race([pending, tick]).finally(() => { clearTimeout(timer); });
      if (read.kind === 'keepalive') {
        if (!signal.aborted) yield read;
        continue;
      }
      if (read.result.done) return;
      yield { kind: 'item', item: read.result.value } as const;
      break;
    }
  }
};
