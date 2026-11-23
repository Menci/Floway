import { copilotIdentityHeaders, isCopilotIdentityHeader } from '../../auth.ts';
import type { CopilotUpstreamFacts } from '../../config.ts';
import type { ModelSelectionHints } from '../../model-selection.ts';
import { hasCopilotQuotaHeaders } from '../../quota.ts';
import { rawModelFor } from '../../routing.ts';
import type { CopilotServices } from '../../service.ts';
import { defineStage, transform } from '@floway-dev/pipeline';
import type { ModelEndpointKey } from '@floway-dev/protocols/common';
import { httpUrl, mergeHeaders, rewriteHttpRequest, setHeader, type HeaderEntry, type HttpRequestFacts, type ProviderBaseOutput, type ProviderInput, type ProviderModelFacts, type ProviderRequestBody } from '@floway-dev/provider';

export const unchanged = { needs: [], consumes: [], provides: [] };

type ModelInput = Pick<ProviderInput<CopilotUpstreamFacts, unknown>, 'provider.model'>;
type SelectedModel = { readonly 'request.copilot.modelKey': string };
type WireRequest = { readonly 'request.http': HttpRequestFacts };
type HttpOutput = Pick<ProviderBaseOutput, 'response.http'>;

export const withPublicModel = <Payload>(facts: ProviderInput<CopilotUpstreamFacts, Payload>) => ({
  ...facts['request.payload'],
  model: facts['provider.model'].id,
});

export const selectModelStage = <Input extends ModelInput>(
  endpoint: ModelEndpointKey,
  needs: readonly (keyof Input & string)[],
  hints: (facts: Input) => ModelSelectionHints,
) => defineStage<Input, Input & SelectedModel, {}, {}>({
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
) => defineStage<ProviderInput<CopilotUpstreamFacts, Omit<Payload, 'model'>>, ProviderInput<CopilotUpstreamFacts, Omit<Payload, 'model'>>, {}, {}>({
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

export const headerStage = <Input extends WireRequest>(
  name: string,
  needs: readonly (keyof Input & string)[],
  rewrite: (facts: Input, headers: readonly HeaderEntry[]) => readonly HeaderEntry[] | Promise<readonly HeaderEntry[]>,
) => defineStage<Input, Input, {}, {}>({
  name,
  through: {
    request: { needs: ['request.http', ...needs], consumes: [], provides: ['request.http'] },
    response: unchanged,
  },
  execute: transform(() => ({
    async request(facts) {
      const request = facts['request.http'];
      const headers = await rewrite(facts, request.headers);
      return headers === request.headers ? facts : { ...facts, 'request.http': { ...request, headers } };
    },
  })),
});

export const keepCopilotWireHeader = (name: string): boolean =>
  name === 'authorization' || name === 'content-type' || isCopilotIdentityHeader(name);

export const wireHeadersStage = headerStage('copilot-wire-headers', [], (_facts, headers) =>
  mergeHeaders(headers, copilotIdentityHeaders()));

export const requestStage = <Input extends ProviderInput<CopilotUpstreamFacts, unknown>>(
  needs: readonly (keyof Input & string)[],
  path: string | ((facts: Input) => string),
  build: (facts: Input, modelKey: string) => ProviderRequestBody,
) => defineStage<Input & SelectedModel, WireRequest, HttpOutput, ProviderBaseOutput, CopilotServices>({
  name: 'build-request',
  through: {
    request: {
      needs: ['provider.upstream', 'request.http', 'request.payload', 'request.copilot.modelKey', ...needs],
      consumes: ['request.copilot.modelKey'],
      provides: ['request.http'],
    },
    response: { needs: ['response.http'], consumes: [], provides: ['response.modelKey'] },
  },
  return: { provides: ['response.http', 'response.modelKey'] },
  async execute(facts, scope) {
    const { 'request.copilot.modelKey': modelKey, ...rest } = facts;
    const upstream = facts['provider.upstream'];
    const startedAt = scope.clock();
    const decision = await scope.services.copilot.access(upstream, scope.services.fetcher(upstream.id), scope.signal);
    if (decision.kind === 'error') {
      const { status, headers, body, transportError } = decision;
      return {
        'response.http': {
          status,
          statusText: '',
          headers,
          body: transportError === undefined ? body : null,
          timing: { startedAt, headersAt: scope.clock() },
          exchange: decision.source,
          ...(transportError === undefined ? {} : { transportError }),
        },
        'response.modelKey': modelKey,
      };
    }
    const pathname = typeof path === 'string' ? path : path(facts);
    const request = rewriteHttpRequest(facts['request.http'], {
      method: 'POST',
      url: httpUrl(`${decision.baseUrl}${pathname}`),
      headers: headers => setHeader(headers, 'authorization', `Bearer ${decision.token.reveal()}`),
      body: build(facts, modelKey),
    });
    return { ...await scope.next({ ...rest, 'request.http': request }), 'response.modelKey': modelKey };
  },
});

type UpstreamInput = Pick<ProviderInput<CopilotUpstreamFacts, unknown>, 'provider.upstream'>;

export const quotaStage = defineStage<UpstreamInput, UpstreamInput, HttpOutput, HttpOutput, CopilotServices>({
  name: 'copilot-quota',
  through: {
    request: { ...unchanged, needs: ['provider.upstream'] },
    response: { ...unchanged, needs: ['response.http'] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const { headers } = back['response.http'];
    if (hasCopilotQuotaHeaders(headers)) {
      scope.defer('copilot-quota', scope.services.copilot.saveQuota(facts['provider.upstream'].id, headers));
    }
    return back;
  },
});
