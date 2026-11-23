import type { ClaudeCodeUpstreamFacts } from './config.ts';
import { isClaudeCodeShapedRequest } from './detection.ts';
import { pickClaudeCodeHeaders } from './headers.ts';
import { parseMessagesStage } from './parse-messages.ts';
import { hasClaudeCodeQuota, type ClaudeCodeService, type ClaudeCodeServices } from './service.ts';
import { backfillRequiredFields } from './stages/anthropic-messages/backfill-required-fields.ts';
import { hoistUserSystemToMessages } from './stages/anthropic-messages/hoist-user-system-to-messages.ts';
import { injectBillingBlock } from './stages/anthropic-messages/inject-billing-block.ts';
import { injectDefaultTemplate } from './stages/anthropic-messages/inject-default-template.ts';
import { injectIdentityBlock } from './stages/anthropic-messages/inject-identity-block.ts';
import { synthesizeMetadataUserId } from './stages/anthropic-messages/synthesize-metadata-user-id.ts';
import type { MessagePayload } from './stages/anthropic-messages/types.ts';
import { observeTerminalSentinel } from './terminal-account.ts';
import { compose, defineStage, secret, transform } from '@floway-dev/pipeline';
import {
  filterHeaders, getHeaderEntry, headersForAnthropicMessagesCall, httpTerminal, httpUrl, isRecord, rewriteHttpRequest,
  type HeaderEntry, type HttpResponseFacts, type ProviderAnthropicInput, type ProviderAnthropicMessagesOutput, type ProviderPipelines,
} from '@floway-dev/provider';

// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go
const ANTHROPIC_MESSAGES_URL = httpUrl('https://api.anthropic.com/v1/messages?beta=true');

// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go#L421-L444
const INBOUND_HEADER_ALLOWLIST = [
  'accept',
  /^x-stainless-(?:retry-count|timeout|lang|package-version|os|arch|runtime|runtime-version|helper-method)$/,
  'anthropic-dangerous-direct-browser-access',
  'x-app',
  'accept-language',
  'sec-fetch-mode',
  'user-agent',
  'content-type',
  'accept-encoding',
  'x-claude-code-session-id',
  'x-client-request-id',
  'anthropic-beta',
  'anthropic-version',
  'authorization',
] as const;

const keepShapedHeader = (name: string): boolean =>
  INBOUND_HEADER_ALLOWLIST.some(rule => typeof rule === 'string' ? rule === name : rule.test(name));

type MessagesInput = ProviderAnthropicInput<ClaudeCodeUpstreamFacts>;
type RoutedFacts = MessagesInput & {
  readonly 'request.claudeCode.shaped': boolean;
  readonly 'request.claudeCode.modelKey': string;
};
type DispatchFacts = RoutedFacts & { readonly 'request.claudeCode.retryUnauthorized': boolean };
type HttpOutput = { readonly 'response.http': HttpResponseFacts };
type ParsedMessages = Omit<ProviderAnthropicMessagesOutput, 'response.modelKey'>;
type Access = Extract<Awaited<ReturnType<ClaudeCodeService['access']>>, { kind: 'access' }>;

const plainHeaders = (entries: readonly HeaderEntry[]): Headers =>
  new Headers(entries.map(([name, value]): [string, string] => [name, typeof value === 'string' ? value : value.reveal()]));

const clientHeaders = (facts: MessagesInput): readonly HeaderEntry[] =>
  headersForAnthropicMessagesCall(facts['request.http'].headers, facts['request.anthropicBeta']);

const identifyRequest = defineStage<MessagesInput, RoutedFacts, {}, {}>({
  name: 'claude-code.identify-request',
  through: {
    request: {
      needs: ['provider.model', 'request.payload', 'request.http', 'request.anthropicBeta'],
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
      return {
        ...facts,
        'request.claudeCode.shaped': isClaudeCodeShapedRequest({
          headers: plainHeaders(clientHeaders(facts)),
          body: { ...facts['request.payload'], model: id },
        }),
        'request.claudeCode.modelKey': providerData.upstreamModelId,
      };
    },
  })),
});

const shapePayload = (name: string, shape: (payload: MessagePayload, facts: MessagesInput) => MessagePayload) =>
  defineStage<RoutedFacts, RoutedFacts, {}, {}>({
    name,
    through: {
      request: { needs: ['request.claudeCode.shaped', 'provider.model', 'provider.upstream', 'request.payload'], consumes: [], provides: ['request.payload'] },
      response: { needs: [], consumes: [], provides: [] },
    },
    execute: transform(() => ({
      request: facts => facts['request.claudeCode.shaped']
        ? facts
        : { ...facts, 'request.payload': shape(facts['request.payload'], facts) },
    })),
  });

const configureHeaders = defineStage<RoutedFacts, RoutedFacts, {}, {}>({
  name: 'claude-code.configure-headers',
  through: {
    request: {
      needs: ['request.claudeCode.shaped', 'request.claudeCode.modelKey', 'request.http', 'request.anthropicBeta'],
      consumes: [],
      provides: ['request.http'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const request = facts['request.http'];
      const authorization = getHeaderEntry(request.headers, 'authorization');
      if (authorization === undefined) throw new TypeError('Claude Code Messages dispatch requires authorization');
      const headers = facts['request.claudeCode.shaped']
        ? filterHeaders(clientHeaders(facts), keepShapedHeader)
        : [...Object.entries(pickClaudeCodeHeaders(facts['request.claudeCode.modelKey'])), authorization];
      return { ...facts, 'request.http': { ...request, headers } };
    },
  })),
});

const authenticateAndDispatch = defineStage<RoutedFacts, DispatchFacts, ParsedMessages, ProviderAnthropicMessagesOutput, ClaudeCodeServices>({
  name: 'claude-code.authenticate-and-dispatch',
  through: {
    request: {
      needs: ['provider.upstream', 'request.claudeCode.modelKey', 'request.http', 'request.payload'],
      consumes: [],
      provides: ['request.http', 'request.claudeCode.retryUnauthorized'],
    },
    response: {
      needs: ['response.http', 'response.anthropicMessages'],
      consumes: [],
      provides: ['response.http', 'response.modelKey', 'response.anthropicMessages'],
    },
  },
  return: { provides: ['response.http', 'response.modelKey', 'response.anthropicMessages'] },
  async execute(facts, scope) {
    const { id: upstreamId } = facts['provider.upstream'];
    const modelKey = facts['request.claudeCode.modelKey'];
    const fetcher = scope.services.fetcher(upstreamId);
    const dispatch = (access: Access, retryUnauthorized: boolean) => scope.next({
      ...facts,
      'request.claudeCode.retryUnauthorized': retryUnauthorized,
      'request.http': rewriteHttpRequest(facts['request.http'], {
        method: 'POST',
        url: ANTHROPIC_MESSAGES_URL,
        headers: [['authorization', secret(`Bearer ${access.entry.token}`)]],
        body: { kind: 'json', value: { ...facts['request.payload'], model: modelKey, stream: true } },
      }),
    });
    const errorResult = (
      result: Extract<Awaited<ReturnType<ClaudeCodeService['access']>>, { kind: 'error' }>,
      startedAt: number,
    ): ProviderAnthropicMessagesOutput => ({
      'response.http': {
        status: result.status,
        statusText: '',
        headers: [['content-type', 'application/json'], ...result.headers],
        body: null,
        timing: { startedAt, headersAt: scope.clock() },
        ...(result.transportError === undefined ? {} : { transportError: result.transportError }),
      },
      'response.modelKey': modelKey,
      'response.anthropicMessages': { kind: 'error', source: result.source, error: result.error },
    });

    const startedAt = scope.clock();
    const access = await scope.services.claudeCode.access(upstreamId, modelKey, fetcher);
    if (access.kind === 'error') return errorResult(access, startedAt);
    const first = await dispatch(access, !access.freshlyMinted);
    if (first['response.http'].status !== 401 || access.freshlyMinted) return { ...first, 'response.modelKey': modelKey };

    const refreshedAt = scope.clock();
    const refreshed = await scope.services.claudeCode.access(upstreamId, modelKey, fetcher, { invalidate: true, rejectedToken: access.entry.token });
    if (refreshed.kind === 'error') return { ...first, ...errorResult(refreshed, refreshedAt) };
    return { ...await dispatch(refreshed, false), 'response.modelKey': modelKey };
  },
});

const observeResponse = defineStage<RoutedFacts, RoutedFacts, HttpOutput, HttpOutput, ClaudeCodeServices>({
  name: 'claude-code.observe-response',
  through: {
    request: { needs: ['provider.upstream', 'request.claudeCode.modelKey'], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http'] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const http = back['response.http'];
    const { id: upstreamId } = facts['provider.upstream'];
    if (hasClaudeCodeQuota(http.status, http.headers)) {
      const modelKey = facts['request.claudeCode.modelKey'];
      scope.defer('claude-code.quota', scope.services.claudeCode.saveQuota(upstreamId, modelKey, http.status, http.headers).then(receipt => {
        if (!receipt.persisted) scope.log.warn('claude_code_quota_persist_failed', { upstream_id: upstreamId, error: `${receipt.error.name}: ${receipt.error.message}` });
        return receipt;
      }));
    }
    return { ...back, 'response.http': observeTerminalSentinel(upstreamId, http, scope) };
  },
});

export const claudeCodePipelines = {
  anthropicMessages: compose<MessagesInput & ProviderAnthropicMessagesOutput, ClaudeCodeServices>()('claude-code.messages', {
    entry: ['provider.upstream', 'provider.model', 'request.http', 'request.payload', 'request.anthropicBeta'],
    exit: ['response.http', 'response.modelKey', 'response.anthropicMessages'],
    stages: [
      identifyRequest,
      shapePayload('claude-code.backfill-required-fields', (payload, facts) => backfillRequiredFields(payload, facts['provider.model'])),
      // Derive session identity from the original first user turn before hoisting system text.
      shapePayload('claude-code.synthesize-metadata-user-id', (payload, facts) => synthesizeMetadataUserId(payload, facts['provider.upstream'].id)),
      shapePayload('claude-code.hoist-user-system', hoistUserSystemToMessages),
      shapePayload('claude-code.inject-billing-block', injectBillingBlock),
      shapePayload('claude-code.inject-identity-block', injectIdentityBlock),
      shapePayload('claude-code.inject-default-template', injectDefaultTemplate),
      authenticateAndDispatch,
      parseMessagesStage,
      observeResponse,
      configureHeaders,
    ],
    ending: httpTerminal,
  }),
} satisfies ProviderPipelines<ClaudeCodeUpstreamFacts, ClaudeCodeServices>;
