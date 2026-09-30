import { authenticateClaudeCode } from '../../src/stages/authenticate.ts';
import { decodeClaudeCodeResponse } from '../../src/stages/decode-response.ts';
import { observeClaudeCodeResponse } from '../../src/stages/observe-response.ts';
import { prepareClaudeCodeRequest } from '../../src/stages/prepare-request.ts';
import { retryClaudeCodeAccess } from '../../src/stages/retry-access.ts';
import { http } from '@floway-dev/http/pipeline';
import { compose, defineStage, move, type RunServices } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { observeProviderCall, type Provider, type ProviderModel, type ProviderStreamResult, type AnthropicMessagesUpstreamCallOptions } from '@floway-dev/provider';
import { collectChatProviderPipeline } from '@floway-dev/test-utils';

interface Options { upstreamId: string; model: ProviderModel; body: Omit<AnthropicMessagesPayload, 'model'>; shaped: boolean; signal?: AbortSignal; call: AnthropicMessagesUpstreamCallOptions; observers?: Pick<RunServices, 'log' | 'dump'> }
export const callClaudeCodeAnthropicMessages = async (opts: Options): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => {
  const prepare = defineStage<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>({
    name: 'supplyClaudeCodePreparedFixture',
    through: { request: { needs: [], consumes: [], provides: ['request.claudeCode.shaped', 'request.provider.modelKey'] }, response: { needs: [], consumes: [], provides: [] } },
    execute: async (facts, next) => move({ ...await next(move({ ...facts, 'request.claudeCode.shaped': opts.shaped, 'request.provider.modelKey': (opts.model.providerData as { upstreamModelId: string }).upstreamModelId })) }),
  });
  const provider: Provider = { upstreamId: opts.upstreamId, kind: 'claude-code', name: 'Claude Code fixture', inboundHeaderAllowlist: [], disabledPublicModelIds: [], modelPrefix: null, modelsCache: null, instance: { getProvidedModels: async () => [] }, pipelines: { anthropicMessages: compose('claudeCode.transportFixture', [prepare, authenticateClaudeCode(opts.upstreamId), prepareClaudeCodeRequest, decodeClaudeCodeResponse(opts.upstreamId), retryClaudeCodeAccess(opts.upstreamId), observeClaudeCodeResponse(opts.upstreamId), observeProviderCall, http]) } };
  const result = await collectChatProviderPipeline(provider, 'anthropicMessages', opts.model, opts.body, opts.signal, opts.call, opts.observers);
  if (result.output !== null && 'kind' in result.output && result.output.kind === 'stream') return { ok: true, modelKey: result.facts['response.provider.modelKey'], events: (async function* () { yield* result.frames; })() };
  if (result.response === null) throw new Error('Expected Messages stream or HTTP failure');
  return { ok: false, modelKey: result.facts['response.provider.modelKey'], response: result.response };
};
