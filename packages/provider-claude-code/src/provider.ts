import { ensureClaudeCodeAccessToken } from './access-token.ts';
import { assertClaudeCodeUpstreamRecord } from './config.ts';
import { CLAUDE_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { isClaudeCodeShapedRequest } from './detection.ts';
import { callClaudeCodeAnthropicMessages } from './fetch.ts';
import { CLAUDE_CODE_ANTHROPIC_MESSAGES_BOUNDARY, type AnthropicMessagesBoundaryCtx } from './interceptors/anthropic-messages/index.ts';
import { buildClaudeCodeCatalog, fetchClaudeCodeModelsList } from './models.ts';
import { assertClaudeCodeUpstreamState } from './state.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import {
  getProviderRepo,
  headersForAnthropicMessagesCall,
  resolveEffectiveFlags,
  type ProviderInstance,
  type Provider,
  type ProviderStreamResult,
  type UpstreamRecord,
} from '@floway-dev/provider';

// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go#L421-L444
const INBOUND_HEADER_ALLOWLIST = [
  'accept',
  /^x-stainless-(?:retry-count|timeout|lang|package-version|os|arch|runtime|runtime-version|helper-method)$/,
  'anthropic-dangerous-direct-browser-access',
  'anthropic-version',
  'x-app',
  'accept-language',
  'sec-fetch-mode',
  'user-agent',
  'content-type',
  'accept-encoding',
  'x-claude-code-session-id',
  'x-client-request-id',
] as const;

export const createClaudeCodeProvider = (record: UpstreamRecord): Provider => {
  assertClaudeCodeUpstreamRecord(record);
  assertClaudeCodeUpstreamState(record.state);

  const enabledFlags = resolveEffectiveFlags([CLAUDE_CODE_DEFAULT_FLAGS, record.flagOverrides]);

  const instance: ProviderInstance = {
    callAlphaSearch: rejectUnsupported('callAlphaSearch'),
    // Catalog refresh mints an access token and hits /v1/models on every
    // dispatcher poll. `ensureClaudeCodeAccessToken` flips the row to
    // `refresh_failed` and throws `ClaudeCodeOAuthSessionTerminatedError`
    // when the refresh_token has died; the throw propagates so the catalog
    // cache records the failure and surfaces it on the dashboard.
    getProvidedModels: async fetcher => {
      const access = await ensureClaudeCodeAccessToken({
        upstreamId: record.id,
        repo: getProviderRepo().upstreams,
        fetcher,
      });
      const apiModels = await fetchClaudeCodeModelsList(access.entry.token, fetcher);
      return buildClaudeCodeCatalog(apiModels, enabledFlags);
    },

    callAnthropicMessages: async (model, body, signal: AbortSignal | undefined, opts) => {
      const ctx: AnthropicMessagesBoundaryCtx = {
        payload: { ...body, model: model.id },
        model,
        upstreamId: record.id,
      };

      // Detection runs on the unmodified payload plus the Claude Code
      // fingerprint admitted by the provider module and Anthropic Messages boundaries.
      // The re-mimicry chain would clobber operator-supplied `system` content
      // and overwrite the wire shape — exactly what a CC-shaped passthrough
      // needs to preserve. So the chain only runs on the unshaped path; the
      // shaped path skips straight to the terminal call, which preserves the
      // caller's own system blocks, metadata and tool shape rather than
      // re-deriving them. The call preserves that filtered fingerprint,
      // supplies the provider-owned OAuth auth, and restamps the resolved model
      // id.
      const looksShaped = isClaudeCodeShapedRequest({
        headers: headersForAnthropicMessagesCall(opts.headers, opts.anthropicBeta),
        body: ctx.payload,
      });

      const terminal = async (): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => {
        // Drop `model` from the payload: callClaudeCodeAnthropicMessages re-attaches the
        // dated upstream id (from `opts.model.providerData.upstreamModelId`) on
        // the wire so Anthropic sees a stable per-revision id rather than the
        // public alias the catalog exposes to clients.
        const { model: _ignored, ...wireBody } = ctx.payload;
        return await callClaudeCodeAnthropicMessages({
          upstreamId: record.id,
          model,
          body: wireBody,
          shaped: looksShaped,
          signal,
          call: opts,
        });
      };

      if (looksShaped) return await terminal();

      return await runInterceptors<AnthropicMessagesBoundaryCtx, ProviderStreamResult<AnthropicMessagesStreamEvent>>(
        ctx,
        CLAUDE_CODE_ANTHROPIC_MESSAGES_BOUNDARY,
        terminal,
      );
    },

    // Only /v1/messages is supported; reject any other endpoint loudly so a
    // dispatcher routing bug surfaces instead of a silent shape mismatch.
    callAnthropicMessagesCountTokens: rejectUnsupported('callAnthropicMessagesCountTokens'),
    callOpenAICompletions: rejectUnsupported('callOpenAICompletions'),
    callOpenAIChatCompletions: rejectUnsupported('callOpenAIChatCompletions'),
    callOpenAIResponses: rejectUnsupported('callOpenAIResponses'),
    callOpenAIEmbeddings: rejectUnsupported('callOpenAIEmbeddings'),
    callOpenAIImagesGenerations: rejectUnsupported('callOpenAIImagesGenerations'),
    callOpenAIImagesEdits: rejectUnsupported('callOpenAIImagesEdits'),
    callOpenAIAudioTranscriptions: rejectUnsupported('callOpenAIAudioTranscriptions'),
    callRerank: rejectUnsupported('callRerank'),
  };

  return {
    upstreamId: record.id,
    kind: 'claude-code',
    name: record.name,
    inboundHeaderAllowlist: INBOUND_HEADER_ALLOWLIST,
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    instance,
  };
};

const rejectUnsupported = (capability: string) => (): Promise<never> =>
  Promise.reject(new Error(`Claude Code provider does not implement ${capability}`));
