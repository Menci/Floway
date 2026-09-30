import { prepareCodexResponsesContent, type PreparedCodexResponsesRequest } from '../backend.ts';
import { accountValue, type CodexAccountFacts } from '../pipeline-facts.ts';
import { defineStage, isSecret, move } from '@floway-dev/pipeline';
import type { ProviderChatResponse } from '@floway-dev/provider';

export interface CodexPreparedResponsesFacts { 'request.codex.responsesPrepared': PreparedCodexResponsesRequest }
export const prepareCodexResponsesPayload = <O extends 'openaiResponses' | 'openaiResponsesCompact'>() => defineStage<CodexAccountFacts<O> & { 'request.provider.responsesAction': 'generate' | 'compact' }, CodexAccountFacts<O> & CodexPreparedResponsesFacts, ProviderChatResponse<O>, ProviderChatResponse<O>>({
  name: 'prepareCodexResponsesPayload',
  through: { request: { needs: ['request.provider.model', 'request.provider.payload', 'request.http.headers', 'request.codex.account', 'request.provider.responsesAction'], consumes: [], provides: ['request.codex.responsesPrepared'] }, response: { needs: [], consumes: [], provides: [] } },
  execute: async (facts, next) => {
    const headers = new Headers(facts['request.http.headers'].map(([name, value]): [string, string] => [name, isSecret(value) ? value.reveal() : value]));
    const prepared = prepareCodexResponsesContent({ account: accountValue(facts['request.codex.account']), model: facts['request.provider.model'], body: facts['request.provider.payload'], headers }, facts['request.provider.responsesAction']);
    return move({ ...await next(move({ ...facts, 'request.codex.responsesPrepared': prepared })) });
  },
});
