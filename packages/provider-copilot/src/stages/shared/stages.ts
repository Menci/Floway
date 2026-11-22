import { copilotRequestHeaders, ensureCopilotToken, isCopilotTokenFetchError, type CopilotAuth } from '../../auth.ts';
import type { ModelSelectionHints } from '../../model-selection.ts';
import { parseCopilotQuotaHeaders, putCopilotQuota } from '../../quota.ts';
import { rawModelFor } from '../../routing.ts';
import { Bytes, defineStage, secret, snapshotError, transform, type Deferred, type ErrorSnapshot, type Secret } from '@floway-dev/pipeline';
import type { ModelEndpointKey } from '@floway-dev/protocols/common';
import { buildHttpRequestStage, httpUrl, wrapSensitiveHeaderEntries, type HeaderEntry, type HttpRequestFacts, type ProviderHttpOutput, type ProviderInput, type ProviderModelFacts, type ProviderRequestBody, type ProviderServices } from '@floway-dev/provider';

export const unchanged = { needs: [], consumes: [], provides: [] };

type ModelInput = Pick<ProviderInput<unknown>, 'provider.model'>;
type SelectedModel = { readonly 'request.copilot.modelKey': string };
type Authenticated = { readonly 'request.copilot.auth': { readonly baseUrl: string; readonly token: Secret<string> } };
type WireRequest = { readonly 'request.http': HttpRequestFacts };
type HeadersInput = Pick<ProviderInput<unknown>, 'request.headers'>;

export const withPublicModel = <Payload>(facts: ProviderInput<Payload>) => ({
  ...facts['request.payload'],
  model: facts['provider.model'].id,
});

export const selectModelStage = <Input extends ModelInput>(
  endpoint: ModelEndpointKey,
  needs: readonly (keyof Input & string)[],
  hints: (facts: Input) => ModelSelectionHints,
) => defineStage<Input, Input & SelectedModel, ProviderHttpOutput, ProviderHttpOutput, ProviderServices>({
  name: 'select-model',
  through: {
    request: { needs: ['provider.model', ...needs], consumes: [], provides: ['request.copilot.modelKey'] },
    response: unchanged,
  },
  execute: transform(() => ({
    request: facts => ({
      ...facts,
      'request.copilot.modelKey': rawModelFor(facts['provider.model'], endpoint, hints(facts)).id,
    }),
  })),
});

export const payloadStage = <Payload extends { model: string }>(
  name: string,
  rewrite: (payload: Omit<Payload, 'model'> & { model: string }, model: ProviderModelFacts) => Payload | Promise<Payload>,
) => defineStage<ProviderInput<Omit<Payload, 'model'>>, ProviderInput<Omit<Payload, 'model'>>, ProviderHttpOutput, ProviderHttpOutput, ProviderServices>({
  name,
  through: {
    request: { needs: ['provider.model', 'request.payload'], consumes: [], provides: ['request.payload'] },
    response: unchanged,
  },
  execute: transform(() => ({
    async request(facts) {
      const { model: _model, ...payload } = await rewrite(withPublicModel(facts), facts['provider.model']);
      return { ...facts, 'request.payload': payload };
    },
  })),
});

export const headersFromEntries = (entries: readonly HeaderEntry[]): Headers => {
  const headers = new Headers();
  for (const [name, value] of entries) headers.append(name, typeof value === 'string' ? value : value.reveal());
  return headers;
};

export const headerStage = <Input extends HeadersInput>(
  name: string,
  needs: readonly (keyof Input & string)[],
  rewrite: (facts: Input, headers: Headers) => void | Promise<void>,
) => defineStage<Input, Input, ProviderHttpOutput, ProviderHttpOutput, ProviderServices>({
  name,
  through: {
    request: { needs: ['request.headers', ...needs], consumes: [], provides: ['request.headers'] },
    response: unchanged,
  },
  execute: transform(() => ({
    async request(facts) {
      const headers = headersFromEntries(facts['request.headers']);
      await rewrite(facts, headers);
      return { ...facts, 'request.headers': wrapSensitiveHeaderEntries(headers) };
    },
  })),
});

export const authStage = (copilot: CopilotAuth) => defineStage<
  SelectedModel, SelectedModel & Authenticated, ProviderHttpOutput, ProviderHttpOutput, ProviderServices
>({
  name: 'copilot-token',
  through: {
    request: { needs: ['request.copilot.modelKey'], consumes: [], provides: ['request.copilot.auth'] },
    response: unchanged,
  },
  return: { provides: ['response.http', 'response.modelKey'] },
  async execute(facts, next, env) {
    const startedAt = env.clock();
    const entry = await ensureCopilotToken(copilot, env.services.fetcher(copilot.id), env.signal).catch((error: unknown) => {
      if (!isCopilotTokenFetchError(error)) throw error;
      return error;
    });
    if (isCopilotTokenFetchError(entry)) {
      return {
        'response.http': {
          status: entry.status,
          statusText: '',
          headers: wrapSensitiveHeaderEntries(entry.headers),
          body: Bytes.fromUtf8(entry.body),
          timing: { startedAt, headersAt: env.clock() },
        },
        'response.modelKey': facts['request.copilot.modelKey'],
      };
    }
    return await next({
      ...facts,
      'request.copilot.auth': { baseUrl: entry.baseUrl, token: secret(entry.token) },
    });
  },
});

export const requestStage = <Input extends ProviderInput<unknown>>(
  name: string,
  needs: readonly (keyof Input & string)[],
  path: string | ((facts: Input) => string),
  build: (facts: Input, modelKey: string) => ProviderRequestBody,
) => buildHttpRequestStage<Input & SelectedModel & Authenticated>(
  name, ['request.payload', 'request.copilot.modelKey', 'request.copilot.auth', ...needs],
  facts => {
    const { baseUrl } = facts['request.copilot.auth'];
    const modelKey = facts['request.copilot.modelKey'];
    const pathname = typeof path === 'string' ? path : path(facts);
    return {
      request: { method: 'POST', url: httpUrl(`${baseUrl}${pathname}`), headers: [], body: build(facts, modelKey) },
      modelKey,
    };
  },
);

export const wireHeadersStage = defineStage<
  WireRequest & Authenticated & HeadersInput, WireRequest, { readonly 'response.http': ProviderHttpOutput['response.http'] }, { readonly 'response.http': ProviderHttpOutput['response.http'] }, ProviderServices
>({
  name: 'copilot-wire-headers',
  through: {
    request: { needs: ['request.http', 'request.copilot.auth', 'request.headers'], consumes: ['request.copilot.auth'], provides: ['request.http'] },
    response: unchanged,
  },
  async execute(facts, next) {
    const { 'request.copilot.auth': auth, 'request.http': request, ...rest } = facts;
    const base = headersFromEntries(request.headers);
    const headers = copilotRequestHeaders(auth.token.reveal(), base, headersFromEntries(facts['request.headers']));
    const contentType = base.get('content-type');
    if (contentType?.startsWith('multipart/form-data;') && !headers.has('content-type')) headers.set('content-type', contentType);
    return await next({ ...rest, 'request.http': { ...request, headers: wrapSensitiveHeaderEntries(headers) } });
  },
});

type QuotaPersistence = { readonly persisted: true } | { readonly persisted: false; readonly error: ErrorSnapshot };
type QuotaResponse = { readonly 'response.copilot.quota': Deferred<QuotaPersistence> | undefined };

export const quotaStage = (upstreamId: string) => defineStage<{}, {}, ProviderHttpOutput, ProviderHttpOutput & QuotaResponse, ProviderServices>({
  name: 'copilot-quota',
  through: {
    request: unchanged,
    response: { needs: ['response.http'], consumes: [], provides: ['response.copilot.quota'] },
  },
  execute: transform(env => ({
    response: back => {
      let snapshot;
      try {
        snapshot = parseCopilotQuotaHeaders(headersFromEntries(back['response.http'].headers), new Date());
      } catch (error) {
        console.warn(`Failed to parse Copilot quota snapshot for ${upstreamId}:`, error);
        return { ...back, 'response.copilot.quota': undefined };
      }
      if (snapshot === null) return { ...back, 'response.copilot.quota': undefined };
      const work = putCopilotQuota(upstreamId, snapshot).then<QuotaPersistence, QuotaPersistence>(
        () => ({ persisted: true }),
        (error: unknown) => {
          console.warn(`Failed to persist Copilot quota snapshot for ${upstreamId}:`, error);
          return { persisted: false, error: snapshotError(error) };
        },
      );
      return {
        ...back,
        'response.copilot.quota': env.defer('copilot-quota', work),
      };
    },
  })),
});
