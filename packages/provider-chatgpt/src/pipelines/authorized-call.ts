import type { ChatGPTTokenLog } from '../access-token.ts';
import type { ChatGPTAccessFailure, ChatGPTServices } from '../service.ts';
import type { ChatGPTUpstreamFact } from '../upstream-fact.ts';
import { readHttpBody, setHeader, type HttpRequestFact, type HttpResponseFact, type HttpStreamError } from '@floway-dev/http';
import { move, type Secret } from '@floway-dev/pipeline';
import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';
import { parseErrorBody, parseJsonBody, type FormatProviderError, type ProtocolError, type ProviderTransportFacts } from '@floway-dev/provider';

interface CallScope {
  readonly services: ChatGPTServices;
  readonly defer: (work: Promise<unknown>) => void;
  readonly log: ChatGPTTokenLog;
}

interface CallFailure {
  readonly http: HttpResponseFact | null;
  readonly outcome: ProtocolError;
}

export const withoutTransportResponse = (back: ProviderTransportFacts | CallFailure) => {
  if ('outcome' in back) return {};
  const { 'response.transport': _transport, ...response } = back;
  return response;
};

const accessError = async (failure: ChatGPTAccessFailure, format: FormatProviderError<unknown>): Promise<CallFailure> => {
  if (failure.kind === 'upstream') return await parseErrorBody(failure.http, format);
  if (failure.kind === 'transport') return transportError(failure.error, failure.http, format);
  const { status, type, message } = failure;
  return {
    http: { status, statusText: status === 403 ? 'Forbidden' : 'Service Unavailable', headers: [['content-type', 'application/json']], body: null },
    outcome: { kind: 'error', source: 'local', error: { error: { type, message } } },
  };
};

const transportError = (failure: HttpStreamError, http: HttpResponseFact | null, format: FormatProviderError<unknown>): CallFailure => {
  const { cause } = failure;
  return {
    http,
    outcome: { kind: 'error', source: 'upstream', error: format(http?.status ?? null, cause instanceof Error ? cause.message : String(cause)), cause: failure },
  };
};

const upstreamErrorFields = (bytes: Uint8Array): { code: string | null; message: string } => {
  const parsed = parseJsonBody(bytes);
  const body = parsed.ok && isJsonObject(parsed.value) ? parsed.value : null;
  const error = body !== null && isJsonObject(body.error) ? body.error : null;
  const code = typeof error?.code === 'string' ? error.code : null;
  const message = typeof error?.message === 'string'
    ? error.message
    : typeof body?.detail === 'string' ? body.detail : new TextDecoder().decode(bytes).slice(0, 256);
  return { code, message };
};

export const parseJsonObject = (bytes: Uint8Array) => {
  const data = parseJsonBody(bytes);
  if (!data.ok) return data;
  return isJsonObject(data.value)
    ? { ok: true, value: data.value satisfies JsonObject } as const
    : { ok: false, error: new TypeError('Expected an upstream JSON object') } as const;
};

export const authorizedCall = async (
  upstream: ChatGPTUpstreamFact,
  prepareRequest: () => HttpRequestFact | Promise<HttpRequestFact>,
  images: boolean,
  scope: CallScope,
  send: (request: HttpRequestFact) => Promise<ProviderTransportFacts>,
  format: FormatProviderError<unknown>,
): Promise<ProviderTransportFacts | CallFailure> => {
  const { services, defer, log } = scope;
  const { chatgpt } = services;
  const { chatgptAccountId } = upstream.config.accounts[0];
  const fetcher = services.fetcher(upstream.id);
  const observePersistence = (event: string, work: Promise<Awaited<ReturnType<typeof chatgpt.observeQuota>>>): void => {
    defer(work.then(result => {
      if (!result.persisted) log.warn(event, { upstream_id: upstream.id, error: result.error });
      return result;
    }));
  };

  const dispatch = async (request: HttpRequestFact, bearer: Secret<string>, retry: boolean): Promise<ProviderTransportFacts | CallFailure> => {
    const authenticated = setHeader(request.headers, 'authorization', bearer);
    const headers = chatgptAccountId === null ? authenticated : setHeader(authenticated, 'chatgpt-account-id', chatgptAccountId);
    const back = await send(move({ ...request, headers }));
    const transport = back['response.transport'];
    if (!transport.ok) return back;
    const http = transport.value;
    if ((http.status >= 200 && http.status < 300) || http.status === 429) {
      observePersistence('chatgpt_quota_persist_failed', chatgpt.observeQuota(upstream, http.headers, http.status, images));
    }
    if (http.status !== 401) return back;

    // Classification needs the body. The cursor reaches native done before
    // another attempt can replace this answer.
    const body = await readHttpBody(http.body);
    if (!body.ok) return transportError(body.error, { ...http, body: null }, format);
    const { code, message } = upstreamErrorFields(body.value);
    const rejection = await chatgpt.observeUnauthorized(upstream, bearer, code, message);
    if (rejection.kind === 'local') return await accessError(rejection, format);
    if (rejection.kind === 'relay' && rejection.persistence !== undefined) {
      observePersistence('chatgpt_terminal_state_persist_failed', rejection.persistence);
    }
    if (rejection.kind === 'retry' && retry) {
      const renewed = await chatgpt.reauthorize(upstream, bearer, fetcher, images, log);
      if (renewed.kind !== 'authorized') return await accessError(renewed, format);
      return await dispatch(request, renewed.bearer, false);
    }
    return { ...back, 'response.transport': move({ ok: true, value: { ...http, body: body.value } }) };
  };

  const access = await chatgpt.authorization(upstream, fetcher, images, log);
  if (access.kind !== 'authorized') return await accessError(access, format);
  return await dispatch(await prepareRequest(), access.bearer, true);
};
