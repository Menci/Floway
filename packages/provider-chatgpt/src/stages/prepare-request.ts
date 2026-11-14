import { CHATGPT_ALPHA_SEARCH_PATH, CHATGPT_BACKEND_BASE, CHATGPT_CLI_VERSION, CHATGPT_OPENAI_IMAGES_EDITS_PATH, CHATGPT_OPENAI_IMAGES_GENERATIONS_PATH, CHATGPT_ORIGINATOR, CHATGPT_USER_AGENT } from '../constants.ts';
import { uuidV7 } from '../ids.ts';
import type { ChatGPTAuthenticatedFacts, ChatGPTHttpFacts, ChatGPTOperation } from '../pipeline-facts.ts';
import { defineStage, isSecret, move } from '@floway-dev/pipeline';
import { serializeOpenAIImagesEditsJsonPayload, type ProviderCallResponse, type ProviderOperationPayloads, type ProviderResponse, type ProviderServices } from '@floway-dev/provider';

const header = (facts: ChatGPTAuthenticatedFacts, name: string): string | null => {
  const value = facts['request.http.headers'].find(([key]) => key.toLowerCase() === name)?.[1];
  const text = value === undefined ? '' : isSecret(value) ? value.reveal() : value;
  return text.trim() || null;
};

export const prepareChatGPTRequest = <O extends ChatGPTOperation>(operation: O) => defineStage<ChatGPTAuthenticatedFacts<O>, ChatGPTHttpFacts, ProviderCallResponse, ProviderResponse, ProviderServices>({
  name: `prepareChatGPT${operation.replace(/^openai/, 'OpenAI').replace(/^alpha/, 'Alpha')}`,
  through: {
    request: {
      needs: ['request.provider.model', 'request.provider.payload', 'request.http.headers', 'request.http.callId', 'request.chatgpt.account', 'request.chatgpt.accessToken', 'request.chatgpt.plan'],
      consumes: ['request.provider.model', 'request.provider.payload', 'request.http.headers'],
      provides: ['request.http.url', 'request.http.method', 'request.http.headers', 'request.http.body', 'request.http.encoding', 'request.chatgpt.modelKey', 'request.chatgpt.model'],
    },
    response: { needs: ['response.http.exchange', 'response.provider.called', 'response.provider.previousCalls'], consumes: [], provides: ['response.provider.modelKey'] },
  },
  execute: async (facts, next) => {
    const { 'request.provider.model': model, 'request.provider.payload': payload, ...rest } = facts;
    let body: Record<string, unknown>;
    let path: string;
    const headers: [string, string][] = [
      ['originator', operation === 'alphaSearch' ? CHATGPT_ORIGINATOR : header(facts, 'originator') ?? CHATGPT_ORIGINATOR],
      ['user-agent', CHATGPT_USER_AGENT],
      ['version', CHATGPT_CLI_VERSION],
      ['accept', 'application/json'],
      ['content-type', 'application/json'],
    ];
    if (operation === 'alphaSearch') {
      const source = payload as ProviderOperationPayloads['alphaSearch'];
      const requestId = typeof source.id === 'string' && source.id.trim().length > 0 ? source.id.trim() : uuidV7();
      body = { ...source, id: requestId, model: model.id };
      path = CHATGPT_ALPHA_SEARCH_PATH;
      headers.push(['session-id', requestId], ['thread-id', requestId], ['x-client-request-id', requestId], ['x-codex-window-id', `${requestId}:0`]);
      const metadata = header(facts, 'x-codex-turn-metadata');
      if (metadata !== null) headers.push(['x-codex-turn-metadata', metadata]);
    } else {
      body = operation === 'openaiImagesEdits'
        ? await serializeOpenAIImagesEditsJsonPayload(payload as ProviderOperationPayloads['openaiImagesEdits'], model.id)
        : { ...payload, model: model.id };
      path = operation === 'openaiImagesEdits' ? CHATGPT_OPENAI_IMAGES_EDITS_PATH : CHATGPT_OPENAI_IMAGES_GENERATIONS_PATH;
      headers.push(['x-codex-image-turn-id', header(facts, 'x-codex-image-turn-id') ?? uuidV7()]);
    }
    const back = await next(move({
      ...rest,
      'request.chatgpt.model': model,
      'request.chatgpt.modelKey': model.id,
      'request.http.url': `${CHATGPT_BACKEND_BASE}${path}`,
      'request.http.method': 'POST',
      'request.http.headers': headers,
      'request.http.body': body,
      'request.http.encoding': 'json' as const,
    }));
    return move({ ...back, 'response.provider.modelKey': model.id });
  },
});
