import { ensureClaudeCodeAccessToken } from './access-token.ts';
import { assertClaudeCodeUpstreamRecord } from './config.ts';
import { CLAUDE_CODE_DEFAULT_FLAGS } from './defaults.ts';
import { isClaudeCodeShapedRequest } from './detection.ts';
import { callClaudeCodeMessages } from './fetch.ts';
import { CLAUDE_CODE_MESSAGES_BOUNDARY, type MessagesBoundaryCtx } from './interceptors/messages/index.ts';
import { buildClaudeCodeCatalog, fetchClaudeCodeModelsList } from './models.ts';
import { assertClaudeCodeUpstreamState } from './state.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import {
  getProviderRepo,
  resolveEffectiveFlags,
  type ProviderInstance,
  type Provider,
  type ProviderStreamResult,
  type UpstreamRecord,
} from '@floway-dev/provider';

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

    callMessages: async (model, body, signal: AbortSignal | undefined, opts) => {
      const ctx: MessagesBoundaryCtx = {
        payload: { ...body, model: model.id },
        model,
        upstreamId: record.id,
      };

      // Detection runs on the inbound, unmodified payload + client headers.
      // The re-mimicry chain would clobber operator-supplied `system` content
      // and overwrite the wire shape — exactly what a CC-shaped passthrough
      // needs to preserve. So the chain only runs on the unshaped path; the
      // shaped path skips straight to the terminal call, which preserves the
      // caller's own system blocks, metadata and tool shape rather than
      // re-deriving them. The call still rebuilds the header surface through
      // the allowlist in `fetch.ts`, swaps Authorization for our cached OAuth
      // token, and restamps the resolved model id.
      const looksShaped = isClaudeCodeShapedRequest({
        headers: opts.headers,
        body: ctx.payload,
      });

      const terminal = async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => {
        // Drop `model` from the payload: callClaudeCodeMessages re-attaches the
        // dated upstream id (from `opts.model.providerData.upstreamModelId`) on
        // the wire so Anthropic sees a stable per-revision id rather than the
        // public alias the catalog exposes to clients.
        const { model: _ignored, ...wireBody } = ctx.payload;
        return await callClaudeCodeMessages({
          upstreamId: record.id,
          model,
          body: wireBody,
          shaped: looksShaped,
          signal,
          call: opts,
        });
      };

      if (looksShaped) return await terminal();

      return await runInterceptors<MessagesBoundaryCtx, object, ProviderStreamResult<MessagesStreamEvent>>(
        ctx,
        {},
        CLAUDE_CODE_MESSAGES_BOUNDARY,
        terminal,
      );
    },

    // Only /v1/messages is supported; reject any other endpoint loudly so a
    // dispatcher routing bug surfaces instead of a silent shape mismatch.
    callMessagesCountTokens: rejectUnsupported('callMessagesCountTokens'),
    callCompletions: rejectUnsupported('callCompletions'),
    callChatCompletions: rejectUnsupported('callChatCompletions'),
    callResponses: rejectUnsupported('callResponses'),
    callEmbeddings: rejectUnsupported('callEmbeddings'),
    callImagesGenerations: rejectUnsupported('callImagesGenerations'),
    callImagesEdits: rejectUnsupported('callImagesEdits'),
    callAudioTranscriptions: rejectUnsupported('callAudioTranscriptions'),
    callRerank: rejectUnsupported('callRerank'),
  };

  return {
    upstreamId: record.id,
    kind: 'claude-code',
    name: record.name,
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    instance,
  };
};

const rejectUnsupported = (capability: string) => (): Promise<never> =>
  Promise.reject(new Error(`Claude Code provider does not implement ${capability}`));
