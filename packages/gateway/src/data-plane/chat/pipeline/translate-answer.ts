import { chatJsonContentType } from './encode.ts';
import type { ChatOperation } from './facts.ts';
import { translateChatStream } from './translate-stream.ts';
import type { GatewayDump } from '../../pipeline/services.ts';
import { filterHeaders, setHeader, type HttpResponseFact } from '@floway-dev/http';
import type { TranslateTrip } from '@floway-dev/translate';
import type { ProtocolError, ProtocolResult, ProtocolStream } from '@floway-dev/upstream';

type TranslationScope = Parameters<typeof translateChatStream>[1];

interface ChatTranslation {
  source: ChatOperation;
  target: ChatOperation;
  dump: GatewayDump | null;
}

type Answer<Event> = ProtocolError | ProtocolStream<Event>;

export const translateChatAnswer = <Input, Output, Scalar>(
  http: HttpResponseFact | null,
  outcome: Answer<Input> | ProtocolResult<Scalar>,
  trip: TranslateTrip<unknown, Output, Input>,
  scope: TranslationScope,
  context: ChatTranslation,
): { http: HttpResponseFact | null; outcome: Answer<Output> } => {
  if (outcome.kind === 'stream') {
    return { http, outcome: { kind: 'stream', stream: translateChatStream(outcome.stream, scope, context, trip.events) } };
  }
  if (outcome.kind === 'result') throw new TypeError(`The ${context.target} generation body returned a scalar`);

  const headers = new Headers();
  for (const [name, value] of http?.headers ?? []) {
    if (typeof value !== 'string') throw new TypeError(`Secret response header ${name} crossed the upstream boundary`);
    headers.append(name, value);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(outcome.error));
  const rendered = trip.error(http?.status ?? (outcome.source === 'upstream' ? 502 : 499), headers, bytes);
  const mapped = rendered === undefined ? outcome : { ...outcome, error: rendered.body };
  if (context.dump !== null && http !== null && outcome.source === 'upstream') {
    const dump = context.dump;
    dump.stageUpstreamTranslationError(mapped, () => {
      dump.setUpstreamTargetApi(context.target);
      dump.upstreamApiError({ status: http.status, headers, body: bytes });
    });
  }
  if (rendered === undefined || http === null) return { http, outcome: mapped };
  const replaced = filterHeaders(http.headers, name => name !== 'content-length' && name !== 'content-encoding');
  return {
    http: {
      ...http,
      status: rendered.status,
      statusText: rendered.status === http.status ? http.statusText : '',
      headers: setHeader(replaced, 'content-type', chatJsonContentType(replaced)),
    },
    outcome: mapped,
  };
};
