import { ensureClaudeCodeAccessToken, invalidateClaudeCodeAccessToken, type EnsuredAccessToken } from './access-token.ts';
import { ClaudeCodeOAuthSessionTerminatedError } from './auth/oauth.ts';
import { isClaudeCodeShapedRequest } from './detection.ts';
import { pickClaudeCodeHeaders } from './headers.ts';
import { parseMessagesStage } from './parse-messages.ts';
import { claudeCodeRateLimitedUntil } from './quota.ts';
import { backfillRequiredFields } from './stages/anthropic-messages/backfill-required-fields.ts';
import { hoistUserSystemToMessages } from './stages/anthropic-messages/hoist-user-system-to-messages.ts';
import { injectBillingBlock } from './stages/anthropic-messages/inject-billing-block.ts';
import { injectDefaultTemplate } from './stages/anthropic-messages/inject-default-template.ts';
import { injectIdentityBlock } from './stages/anthropic-messages/inject-identity-block.ts';
import { synthesizeMetadataUserId } from './stages/anthropic-messages/synthesize-metadata-user-id.ts';
import type { MessagePayload } from './stages/anthropic-messages/types.ts';
import { readClaudeCodeUpstreamState } from './state.ts';
import { observeTerminalSentinel, type TerminalSentinelResult } from './terminal-account.ts';
import { observeQuota, type PersistenceResult } from './usage-persistence.ts';
import { Bytes, compose, defineStage, isManagedStream, secret, transform, type Deferred, type StageEnv } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import {
  encodeHttpRequest, getProviderRepo, headersForAnthropicMessagesCall, httpTerminal, httpUrl, isRecord,
  type HeaderEntry, type HttpRequestFacts, type HttpResponseFacts, type ProviderAnthropicInput,
  type ProviderHttpOutput, type ProviderPipelines, type ProviderServices, type ProviderStreamOutput,
} from '@floway-dev/provider';

// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go
const ANTHROPIC_MESSAGES_URL = httpUrl('https://api.anthropic.com/v1/messages?beta=true');

type HttpInput = { readonly 'request.http': HttpRequestFacts };
type HttpOutput = { readonly 'response.http': HttpResponseFacts };
type RoutedFacts = ProviderAnthropicInput & {
  readonly 'request.claudeCode.shaped': boolean;
  readonly 'request.claudeCode.modelKey': string;
};
type ObservationFacts = {
  readonly 'response.claudeCode.quota': Deferred<PersistenceResult> | undefined;
  readonly 'response.claudeCode.terminalSentinel': Deferred<TerminalSentinelResult> | undefined;
};
type MessagesOutput = ProviderStreamOutput<AnthropicMessagesStreamEventEx> & ObservationFacts;

const plainHeaders = (entries: readonly HeaderEntry[]): Headers =>
  new Headers(entries.map(([name, value]): [string, string] => [name, typeof value === 'string' ? value : value.reveal()]));

const clientHeaders = (facts: ProviderAnthropicInput): readonly HeaderEntry[] =>
  headersForAnthropicMessagesCall(facts['request.headers'], facts['request.anthropicBeta']);

const identifyRequest = defineStage<ProviderAnthropicInput, RoutedFacts, {}, {}, ProviderServices>({
  name: 'claude-code.identify-request',
  through: {
    request: {
      needs: ['provider.model', 'request.payload', 'request.headers', 'request.anthropicBeta'],
      consumes: [],
      provides: ['request.claudeCode.shaped', 'request.claudeCode.modelKey'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const { id, providerData } = facts['provider.model'];
      if (!isRecord(providerData) || typeof providerData.upstreamModelId !== 'string') {
        throw new TypeError(`Claude Code model ${id} is missing providerData.upstreamModelId`);
      }
      const shaped = isClaudeCodeShapedRequest({
        headers: plainHeaders(clientHeaders(facts)),
        body: { ...facts['request.payload'], model: id },
      });
      return {
        ...facts,
        'request.claudeCode.shaped': shaped,
        'request.claudeCode.modelKey': providerData.upstreamModelId,
      };
    },
  })),
});

const shapePayload = (name: string, shape: (payload: MessagePayload, model: ProviderAnthropicInput['provider.model']) => MessagePayload) =>
  defineStage<RoutedFacts, RoutedFacts, {}, {}, ProviderServices>({
    name,
    through: {
      request: { needs: ['request.claudeCode.shaped', 'provider.model', 'request.payload'], consumes: [], provides: ['request.payload'] },
      response: { needs: [], consumes: [], provides: [] },
    },
    execute: transform(() => ({
      request: facts => facts['request.claudeCode.shaped']
        ? facts
        : { ...facts, 'request.payload': shape(facts['request.payload'], facts['provider.model']) },
    })),
  });

const syntheticResponse = (status: number, body: object, headers: readonly HeaderEntry[], env: StageEnv<ProviderServices>): HttpResponseFacts => {
  const now = env.clock();
  return {
    status,
    statusText: '',
    headers: [['content-type', 'application/json'], ...headers],
    body: Bytes.fromUtf8(JSON.stringify(body)),
    timing: { startedAt: now, headersAt: now },
  };
};
const unavailable = (message: string, env: StageEnv<ProviderServices>): HttpResponseFacts =>
  syntheticResponse(503, { error: { type: 'claude_code_upstream_unavailable', message } }, [], env);

const authenticateAndDispatch = (upstreamId: string) => defineStage<RoutedFacts, HttpInput, HttpOutput, ProviderHttpOutput, ProviderServices>({
  name: 'claude-code.authenticate-and-dispatch',
  through: {
    request: {
      needs: ['request.claudeCode.shaped', 'request.claudeCode.modelKey', 'request.headers', 'request.anthropicBeta', 'request.payload'],
      consumes: [],
      provides: ['request.http'],
    },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http', 'response.modelKey'] },
  },
  return: { provides: ['response.http', 'response.modelKey'] },
  async execute(facts, next, env) {
    const modelKey = facts['request.claudeCode.modelKey'];
    const result = (response: HttpResponseFacts, child?: HttpOutput): ProviderHttpOutput => ({
      ...child,
      'response.http': response,
      'response.modelKey': modelKey,
    });
    const repo = getProviderRepo().upstreams;
    const fresh = await repo.getById(upstreamId);
    if (!fresh) throw new Error(`Claude Code upstream ${upstreamId} disappeared mid-request`);
    const account = readClaudeCodeUpstreamState(fresh.state).accounts[0];
    if (account.state !== 'active') return result(unavailable(`Claude Code account is ${account.state}: ${account.stateMessage}`, env));

    const now = Date.now();
    const reset = claudeCodeRateLimitedUntil(account.quotaSnapshot, now, modelKey);
    if (reset !== null) {
      const seconds = Math.max(0, Math.ceil((Date.parse(reset) - now) / 1000));
      const error = { type: 'claude_code_rate_limited', message: `Claude Code upstream rate-limited until ${reset}`, retry_at: reset };
      return result(syntheticResponse(429, { error }, [['retry-after', String(seconds)]], env));
    }

    const ensure = async (): Promise<EnsuredAccessToken | HttpResponseFacts> => {
      try {
        return await ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: env.services.fetcher(upstreamId) });
      } catch (error) {
        if (!(error instanceof ClaudeCodeOAuthSessionTerminatedError)) throw error;
        return unavailable(`Claude Code refresh failed: ${error.upstreamMessage}`, env);
      }
    };
    const access = await ensure();
    if (!('entry' in access)) return result(access);

    const headers = facts['request.claudeCode.shaped']
      ? clientHeaders(facts).filter(([name]) => name.toLowerCase() !== 'authorization')
      : Object.entries(pickClaudeCodeHeaders(modelKey));
    const request = encodeHttpRequest({
      method: 'POST',
      url: ANTHROPIC_MESSAGES_URL,
      headers,
      body: { kind: 'json', value: { ...facts['request.payload'], model: modelKey, stream: true } },
    });
    const dispatch = (token: EnsuredAccessToken) => next({
      ...facts,
      'request.http': { ...request, headers: [...request.headers, ['authorization', secret(`Bearer ${token.entry.token}`)]] },
    });
    const first = await dispatch(access);
    const response = first['response.http'];
    if (response.status !== 401 || access.freshlyMinted) return result(response, first);
    if (isManagedStream(response.body)) await response.body.close();
    await invalidateClaudeCodeAccessToken({ upstreamId, repo });
    const refreshed = await ensure();
    if (!('entry' in refreshed)) return result(refreshed, first);
    const retried = await dispatch(refreshed);
    return result(retried['response.http'], retried);
  },
});

const observeResponse = (upstreamId: string) => defineStage<
  {}, {}, ProviderHttpOutput, ProviderHttpOutput & ObservationFacts, ProviderServices
>({
  name: 'claude-code.observe-response',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: ['response.http', 'response.modelKey'],
      consumes: [],
      provides: ['response.http', 'response.claudeCode.quota', 'response.claudeCode.terminalSentinel'],
    },
  },
  async execute(facts, next, env) {
    const back = await next(facts);
    const http = back['response.http'];
    const quota = observeQuota(upstreamId, back['response.modelKey'], http.status, plainHeaders(http.headers), env);
    const terminal = observeTerminalSentinel(upstreamId, http, env);
    return {
      ...back,
      'response.http': terminal.response,
      'response.claudeCode.quota': quota,
      'response.claudeCode.terminalSentinel': terminal.observation,
    };
  },
});

export const createClaudeCodePipelines = (upstreamId: string) => ({
  anthropicMessages: compose<ProviderAnthropicInput, MessagesOutput, ProviderServices>('claude-code.messages', {
    stages: [
      identifyRequest,
      shapePayload('claude-code.backfill-required-fields', backfillRequiredFields),
      // Derive session identity from the original first user turn before hoisting system text.
      shapePayload('claude-code.synthesize-metadata-user-id', payload => synthesizeMetadataUserId(payload, upstreamId)),
      shapePayload('claude-code.hoist-user-system', hoistUserSystemToMessages),
      shapePayload('claude-code.inject-billing-block', injectBillingBlock),
      shapePayload('claude-code.inject-identity-block', injectIdentityBlock),
      shapePayload('claude-code.inject-default-template', injectDefaultTemplate),
      parseMessagesStage(upstreamId),
      observeResponse(upstreamId),
      authenticateAndDispatch(upstreamId),
    ],
    ending: httpTerminal(upstreamId),
  }),
}) satisfies ProviderPipelines;
