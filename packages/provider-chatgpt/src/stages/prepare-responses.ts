import type { ChatGPTPreparedResponsesFacts } from './prepare-responses-content.ts';
import { CHATGPT_BACKEND_BASE, CHATGPT_CLI_VERSION, CHATGPT_OPENAI_RESPONSES_COMPACT_PATH, CHATGPT_OPENAI_RESPONSES_PATH, CHATGPT_ORIGINATOR, CHATGPT_RESPONSES_LITE_HEADER, CHATGPT_USER_AGENT } from '../constants.ts';
import { type ChatGPTAuthenticatedFacts, type ChatGPTHttpFacts } from '../pipeline-facts.ts';
import type { ChatGPTResponsesLiteRequest } from '../responses-lite.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProviderChatResponse, ProviderChatServices } from '@floway-dev/provider';

export interface ChatGPTResponsesHttpFacts extends ChatGPTHttpFacts {
  'request.provider.responsesAction': 'generate' | 'compact';
  'request.chatgpt.movedResponsesFields': ChatGPTResponsesLiteRequest['movedFields'];
}

export const prepareChatGPTResponsesHttp = <O extends 'openaiResponses' | 'openaiResponsesCompact'>() => defineStage<ChatGPTAuthenticatedFacts<O> & Pick<ChatGPTResponsesHttpFacts, 'request.provider.responsesAction'> & ChatGPTPreparedResponsesFacts, ChatGPTResponsesHttpFacts, ProviderChatResponse<O>, ProviderChatResponse<O>, ProviderChatServices>({
  name: 'prepareChatGPTResponsesHttp',
  through: {
    request: {
      needs: ['request.provider.model', 'request.provider.payload', 'request.http.headers', 'request.http.callId', 'request.chatgpt.account', 'request.chatgpt.accessToken', 'request.chatgpt.plan', 'request.provider.responsesAction', 'request.chatgpt.responsesPrepared'],
      consumes: ['request.provider.model', 'request.provider.payload', 'request.http.headers', 'request.chatgpt.responsesPrepared'],
      provides: ['request.http.url', 'request.http.method', 'request.http.headers', 'request.http.body', 'request.http.encoding', 'request.chatgpt.model', 'request.chatgpt.modelKey', 'request.provider.modelKey', 'request.provider.responsesAction', 'request.chatgpt.movedResponsesFields'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const { 'request.provider.model': model, 'request.provider.payload': _body, 'request.chatgpt.responsesPrepared': prepared, ...rest } = facts;
    const action = facts['request.provider.responsesAction'];
    const { identity } = prepared;
    const headers: [string, string][] = [
      ['originator', CHATGPT_ORIGINATOR], ['user-agent', CHATGPT_USER_AGENT], ['version', CHATGPT_CLI_VERSION],
      ['accept', action === 'compact' ? 'application/json' : 'text/event-stream'], ['content-type', 'application/json'],
      ['session-id', identity.sessionId], ['thread-id', identity.threadId], ['x-client-request-id', identity.clientRequestId],
      ['x-codex-window-id', identity.windowId], ['x-codex-turn-metadata', prepared.turnMetadataJson.header],
    ];
    if (prepared.responsesLite) headers.push([CHATGPT_RESPONSES_LITE_HEADER, 'true']);
    return move({
      ...await next(move({
        ...rest, 'request.chatgpt.model': model, 'request.chatgpt.modelKey': model.id, 'request.provider.modelKey': model.id,
        'request.provider.responsesAction': action, 'request.chatgpt.movedResponsesFields': prepared.movedFields,
        'request.http.url': `${CHATGPT_BACKEND_BASE}${action === 'compact' ? CHATGPT_OPENAI_RESPONSES_COMPACT_PATH : CHATGPT_OPENAI_RESPONSES_PATH}`,
        'request.http.method': 'POST', 'request.http.headers': headers, 'request.http.body': prepared.body, 'request.http.encoding': 'json' as const,
      })),
    });
  },
});
