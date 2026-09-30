import { CODEX_BACKEND_BASE, CODEX_CLI_VERSION, CODEX_OPENAI_RESPONSES_COMPACT_PATH, CODEX_OPENAI_RESPONSES_PATH, CODEX_ORIGINATOR, CODEX_RESPONSES_LITE_HEADER, CODEX_USER_AGENT } from '../constants.ts';
import { prepareCodexResponsesContent } from '../fetch.ts';
import { codexCall, type CodexAuthenticatedFacts, type CodexHttpFacts, type CodexPipelineConfig } from '../pipeline-facts.ts';
import type { CodexResponsesLiteRequest } from '../responses-lite.ts';
import { defineStage, isSecret, move } from '@floway-dev/pipeline';
import type { ProviderChatResponse, ProviderChatServices } from '@floway-dev/provider';

export interface CodexResponsesHttpFacts extends CodexHttpFacts {
  'request.provider.responsesAction': 'generate' | 'compact';
  'request.codex.responsesLite': CodexResponsesLiteRequest | null;
}

export const prepareCodexResponses = <O extends 'openaiResponses' | 'openaiResponsesCompact'>(config: CodexPipelineConfig, _operation: O) => defineStage<CodexAuthenticatedFacts<O> & Pick<CodexResponsesHttpFacts, 'request.provider.responsesAction'>, CodexResponsesHttpFacts, ProviderChatResponse<O>, ProviderChatResponse<O>, ProviderChatServices>({
  name: 'prepareCodexResponses',
  through: {
    request: {
      needs: ['request.provider.model', 'request.provider.payload', 'request.http.headers', 'request.http.callId', 'request.codex.account', 'request.codex.accessToken', 'request.codex.plan', 'request.provider.responsesAction'],
      consumes: ['request.provider.model', 'request.provider.payload', 'request.http.headers'],
      provides: ['request.http.url', 'request.http.method', 'request.http.headers', 'request.http.body', 'request.http.encoding', 'request.codex.model', 'request.codex.modelKey', 'request.provider.modelKey', 'request.provider.responsesAction', 'request.codex.responsesLite'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next, use) => {
    const { 'request.provider.model': model, 'request.provider.payload': body, ...rest } = facts;
    const action = facts['request.provider.responsesAction'];
    const inbound = new Headers(facts['request.http.headers'].map(([name, value]) => [name, isSecret(value) ? value.reveal() : value]));
    const prepared = prepareCodexResponsesContent({ ...codexCall(config, facts, use, model), headers: inbound, body }, action);
    const { identity } = prepared;
    const headers: [string, string][] = [
      ['originator', CODEX_ORIGINATOR], ['user-agent', CODEX_USER_AGENT], ['version', CODEX_CLI_VERSION],
      ['accept', action === 'compact' ? 'application/json' : 'text/event-stream'], ['content-type', 'application/json'],
      ['session-id', identity.sessionId], ['thread-id', identity.threadId], ['x-client-request-id', identity.clientRequestId],
      ['x-codex-window-id', identity.windowId], ['x-codex-turn-metadata', prepared.turnMetadataJson.header],
    ];
    if (prepared.lite !== undefined) headers.push([CODEX_RESPONSES_LITE_HEADER, 'true']);
    return move({
      ...await next(move({
        ...rest, 'request.codex.model': model, 'request.codex.modelKey': model.id, 'request.provider.modelKey': model.id,
        'request.provider.responsesAction': action, 'request.codex.responsesLite': prepared.lite ?? null,
        'request.http.url': `${CODEX_BACKEND_BASE}${action === 'compact' ? CODEX_OPENAI_RESPONSES_COMPACT_PATH : CODEX_OPENAI_RESPONSES_PATH}`,
        'request.http.method': 'POST', 'request.http.headers': headers, 'request.http.body': prepared.body, 'request.http.encoding': 'json' as const,
      })),
    });
  },
});
