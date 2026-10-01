import { copilotRequestHeaders } from '../auth.ts';
import type { AuthenticatedChatFacts, CopilotChatHttpFacts } from '../chat-facts.ts';
import { COMPACTION_TRIGGER } from '../compaction.ts';
import { defineStage, isSecret, move, secret, type Secret } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ChatProviderOperation, ProviderResponse, ProviderServices } from '@floway-dev/provider';

export const prepareCopilotChatRequest = (operation: ChatProviderOperation) => defineStage<AuthenticatedChatFacts, CopilotChatHttpFacts, ProviderResponse, ProviderResponse, ProviderServices>({
  name: `prepareCopilot${operation}`,
  through: {
    request: { needs: [...(operation === 'openaiResponses' || operation === 'openaiResponsesCompact' ? ['request.provider.responsesAction' as const] : []), 'request.provider.payload', 'request.provider.modelKey', 'request.http.headers', 'request.http.callId', 'request.copilot.session'], consumes: ['request.provider.model', 'request.provider.payload', 'request.copilot.session', 'request.http.headers'], provides: ['request.http.url', 'request.http.method', 'request.http.headers', 'request.http.body', 'request.http.encoding'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const { 'request.provider.payload': payload, 'request.copilot.session': session, 'request.provider.model': _, ...rest } = facts;
    const admitted = facts['request.http.headers'].map(([name, value]): [string, string] => [name, isSecret(value) ? value.reveal() : value]);
    if (operation === 'anthropicMessages' || operation === 'anthropicMessagesCountTokens') {
      const beta = facts['request.provider.anthropicBeta']!;
      for (let i = admitted.length - 1; i >= 0; i--) if (admitted[i]![0].toLowerCase() === 'anthropic-beta') admitted.splice(i, 1);
      if (beta.length > 0) admitted.push(['anthropic-beta', beta.join(',')]);
    }
    const headers = [...copilotRequestHeaders({ ...session, token: session.token.reveal() }, undefined, admitted)].map(([name, value]): [string, string | Secret<string>] => [name, name.toLowerCase() === 'authorization' ? secret(value) : value]);
    const path = operation === 'openaiChatCompletions' ? '/chat/completions' : operation === 'anthropicMessages' ? '/v1/messages' : operation === 'anthropicMessagesCountTokens' ? '/v1/messages/count_tokens' : '/responses';
    const compact = 'request.provider.responsesAction' in facts && facts['request.provider.responsesAction'] === 'compact';
    const body = { ...payload, model: facts['request.provider.modelKey'], ...(operation === 'anthropicMessagesCountTokens' ? {} : { stream: !compact }), ...(compact ? { input: [...(payload as CanonicalOpenAIResponsesPayload).input, COMPACTION_TRIGGER] } : {}) };
    return move({ ...await next(move({ ...rest, 'request.http.url': `${session.baseUrl}${path}`, 'request.http.method': 'POST', 'request.http.headers': headers, 'request.http.body': body, 'request.http.encoding': 'json' })) });
  },
});
