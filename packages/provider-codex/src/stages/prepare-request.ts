import { CODEX_ALPHA_SEARCH_PATH, CODEX_BACKEND_BASE, CODEX_CLI_VERSION, CODEX_OPENAI_IMAGES_EDITS_PATH, CODEX_OPENAI_IMAGES_GENERATIONS_PATH, CODEX_ORIGINATOR, CODEX_USER_AGENT } from '../constants.ts';
import { uuidV7 } from '../ids.ts';
import type { CodexAuthenticatedFacts, CodexHttpFacts, CodexOperation } from '../pipeline-facts.ts';
import { defineStage, isSecret, move } from '@floway-dev/pipeline';
import { serializeOpenAIImagesEditsJsonPayload, type ProviderCallResponse, type ProviderOperationPayloads, type ProviderResponse, type ProviderServices } from '@floway-dev/provider';

const header = (facts: CodexAuthenticatedFacts, name: string): string | null => {
  const value = facts['request.http.headers'].find(([key]) => key.toLowerCase() === name)?.[1];
  const text = value === undefined ? '' : isSecret(value) ? value.reveal() : value;
  return text.trim() || null;
};

export const prepareCodexRequest = <O extends CodexOperation>(operation: O) => defineStage<CodexAuthenticatedFacts<O>, CodexHttpFacts, ProviderCallResponse, ProviderResponse, ProviderServices>({
  name: `prepareCodex${operation.replace(/^openai/, 'OpenAI').replace(/^alpha/, 'Alpha')}`,
  through: {
    request: {
      needs: ['request.provider.model', 'request.provider.payload', 'request.http.headers', 'request.http.callId', 'request.codex.account', 'request.codex.accessToken', 'request.codex.plan'],
      consumes: ['request.provider.model', 'request.provider.payload', 'request.http.headers'],
      provides: ['request.http.url', 'request.http.method', 'request.http.headers', 'request.http.body', 'request.http.encoding', 'request.codex.modelKey', 'request.codex.model', 'request.provider.modelKey'],
    },
    response: { needs: ['response.http.exchange', 'response.provider.called', 'response.provider.previousCalls'], consumes: [], provides: ['response.provider.modelKey'] },
  },
  execute: async (facts, next) => {
    const { 'request.provider.model': model, 'request.provider.payload': payload, ...rest } = facts;
    let body: Record<string, unknown>;
    let path: string;
    const headers: [string, string][] = [
      ['originator', operation === 'alphaSearch' ? CODEX_ORIGINATOR : header(facts, 'originator') ?? CODEX_ORIGINATOR],
      ['user-agent', CODEX_USER_AGENT],
      ['version', CODEX_CLI_VERSION],
      ['accept', 'application/json'],
      ['content-type', 'application/json'],
    ];
    if (operation === 'alphaSearch') {
      const source = payload as ProviderOperationPayloads['alphaSearch'];
      const requestId = typeof source.id === 'string' && source.id.trim().length > 0 ? source.id.trim() : uuidV7();
      body = { ...source, id: requestId, model: model.id };
      path = CODEX_ALPHA_SEARCH_PATH;
      headers.push(['session-id', requestId], ['thread-id', requestId], ['x-client-request-id', requestId], ['x-codex-window-id', `${requestId}:0`]);
      const metadata = header(facts, 'x-codex-turn-metadata');
      if (metadata !== null) headers.push(['x-codex-turn-metadata', metadata]);
    } else {
      body = operation === 'openaiImagesEdits'
        ? await serializeOpenAIImagesEditsJsonPayload(payload as ProviderOperationPayloads['openaiImagesEdits'], model.id)
        : { ...payload, model: model.id };
      path = operation === 'openaiImagesEdits' ? CODEX_OPENAI_IMAGES_EDITS_PATH : CODEX_OPENAI_IMAGES_GENERATIONS_PATH;
      headers.push(['x-codex-image-turn-id', header(facts, 'x-codex-image-turn-id') ?? uuidV7()]);
    }
    const back = await next(move({
      ...rest,
      'request.codex.model': model,
      'request.codex.modelKey': model.id,
      'request.provider.modelKey': model.id,
      'request.http.url': `${CODEX_BACKEND_BASE}${path}`,
      'request.http.method': 'POST',
      'request.http.headers': headers,
      'request.http.body': body,
      'request.http.encoding': 'json' as const,
    }));
    return move({ ...back, 'response.provider.modelKey': model.id });
  },
});
