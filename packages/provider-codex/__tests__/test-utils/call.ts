import type { CodexBackendCallBase, CodexCallEffects } from '../../src/backend.ts';
import { createCodexPipelines } from '../../src/pipelines.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesCompactionResult, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import type { Provider, ProviderModel, ProviderOperationPayloads, UpstreamCallOptions } from '@floway-dev/provider';
import { callProviderPipeline, collectChatProviderPipeline, type ProviderStreamResult } from '@floway-dev/test-utils';

interface CallOptions extends CodexBackendCallBase { model: ProviderModel }
interface ResponsesOptions extends CallOptions { body: Omit<CanonicalOpenAIResponsesPayload, 'model'> }
const providerFor = (opts: CallOptions, fallbackPlanType: string | undefined = undefined): Provider => ({
  upstreamId: opts.upstreamId, kind: 'codex', name: 'Codex test', inboundHeaderAllowlist: [], disabledPublicModelIds: [], modelPrefix: null, modelsCache: null,
  instance: { getProvidedModels: async () => [] },
  pipelines: createCodexPipelines({ upstreamId: opts.upstreamId, readAccount: async () => opts.account, effects: opts.effects, fallbackPlanType }),
});
const optionsFor = (opts: CallOptions): UpstreamCallOptions => ({ ...opts.call, headers: opts.headers });
const replay = async function* (frames: readonly ProtocolFrame<OpenAIResponsesStreamEvent>[]) { yield* frames; };
export const callCodexOpenAIResponses = async (opts: ResponsesOptions): Promise<ProviderStreamResult<OpenAIResponsesStreamEvent>> => {
  const result = await collectChatProviderPipeline(providerFor(opts), 'openaiResponses', opts.model, opts.body, opts.signal, optionsFor(opts));
  if (result.output !== null && 'kind' in result.output && result.output.kind === 'stream') {
    const exchange = result.facts['response.http.exchange'];
    if (exchange.type === 'transportFailure') throw exchange.error;
    return { ok: true, modelKey: result.facts['response.provider.modelKey'], events: replay(result.frames), headers: new Headers(exchange.headers.map(([name, value]): [string, string] => [name, value])) };
  }
  if (result.response === null) throw new Error('Expected Responses stream or HTTP failure');
  return { ok: false, modelKey: result.facts['response.provider.modelKey'], response: result.response };
};
export const callCodexOpenAIResponsesCompact = async (opts: ResponsesOptions): Promise<{ ok: true; result: OpenAIResponsesCompactionResult; modelKey: string } | { ok: false; response: Response; modelKey: string }> => {
  const result = await collectChatProviderPipeline(providerFor(opts), 'openaiResponsesCompact', opts.model, opts.body, opts.signal, optionsFor(opts));
  if (result.output !== null && 'kind' in result.output && result.output.kind === 'value') return { ok: true, modelKey: result.facts['response.provider.modelKey'], result: result.output.body };
  if (result.response === null) throw new Error('Expected compaction value or HTTP failure');
  return { ok: false, modelKey: result.facts['response.provider.modelKey'], response: result.response };
};
export const callCodexAlphaSearch = (opts: CallOptions & { body: Record<string, unknown> }) => callProviderPipeline(providerFor(opts), 'alphaSearch', opts.model, opts.body, opts.signal, optionsFor(opts));
export const callCodexOpenAIImagesGenerations = (opts: CallOptions & { body: Omit<OpenAIImagesGenerationsPayload, 'model'>; fallbackPlanType: string | undefined }) => callProviderPipeline(providerFor(opts, opts.fallbackPlanType), 'openaiImagesGenerations', opts.model, opts.body as ProviderOperationPayloads['openaiImagesGenerations'], opts.signal, optionsFor(opts));
export type { CodexCallEffects };
