import { PUBLIC_DATA_PLANE_ROUTES, type PublicDataPlaneRouteId } from '@floway-dev/protocols/common';

export type ApiDocsGroup = 'models' | 'generation' | 'media' | 'rerank' | 'search';

export interface ApiDocsEndpoint<Name extends string = string> {
  docs: string;
  group: ApiDocsGroup;
  method: 'GET' | 'POST';
  name: Name;
  path: string;
  route: PublicDataPlaneRouteId;
}

const openAi = 'https://platform.openai.com/docs/api-reference';
const codexSearchDocs = 'https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/search.rs#L8-L29';

const endpoint = <const Name extends string>(
  route: PublicDataPlaneRouteId,
  metadata: Pick<ApiDocsEndpoint<Name>, 'docs' | 'group' | 'name'> & { path?: string },
): ApiDocsEndpoint<Name> => {
  const manifest = PUBLIC_DATA_PLANE_ROUTES[route];
  return { route, method: manifest.method, path: metadata.path ?? manifest.paths.join(', '), ...metadata };
};

const geminiGenerateContentActionPath = (action: string) =>
  PUBLIC_DATA_PLANE_ROUTES.geminiGenerateContentAction.paths[0].replace(':modelAction{.+}', `{model}:${action}`);

export const authCurlExample = (origin: string) =>
  `curl "${origin}/v1/models" -H "Authorization: Bearer $FLOWAY_API_KEY"`;

export const apiDocsEndpoints = [
  endpoint('models', { group: 'models', name: 'openAiModels', docs: `${openAi}/models/list` }),
  endpoint('geminiModels', { group: 'models', name: 'geminiModels', docs: 'https://ai.google.dev/api/models' }),
  endpoint('geminiModel', { group: 'models', name: 'geminiModel', docs: 'https://ai.google.dev/api/models', path: PUBLIC_DATA_PLANE_ROUTES.geminiModel.paths[0].replace(':modelId{.+}', '{model}') }),

  endpoint('completions', { group: 'generation', name: 'openAiCompletions', docs: `${openAi}/completions/create` }),
  endpoint('openaiChatCompletions', { group: 'generation', name: 'openAiChat', docs: `${openAi}/chat/create` }),
  endpoint('openaiResponses', { group: 'generation', name: 'openAiResponses', docs: `${openAi}/responses/create` }),
  endpoint('openaiResponsesCompact', { group: 'generation', name: 'openAiCompact', docs: `${openAi}/responses/compact` }),
  endpoint('openaiResponsesWebSocket', { group: 'generation', name: 'openAiResponsesWs', docs: 'https://developers.openai.com/api/docs/guides/websocket-mode' }),
  endpoint('anthropicMessages', { group: 'generation', name: 'anthropicMessages', docs: 'https://docs.anthropic.com/en/api/messages' }),
  endpoint('anthropicMessagesCountTokens', { group: 'generation', name: 'anthropicCount', docs: 'https://docs.anthropic.com/en/api/messages-count-tokens' }),
  endpoint('geminiGenerateContentAction', { group: 'generation', name: 'geminiGenerateContentGenerate', docs: 'https://ai.google.dev/api/generate-content', path: geminiGenerateContentActionPath('generateContent') }),
  endpoint('geminiGenerateContentAction', { group: 'generation', name: 'geminiGenerateContentStream', docs: 'https://ai.google.dev/api/generate-content', path: geminiGenerateContentActionPath('streamGenerateContent') }),
  endpoint('geminiGenerateContentAction', { group: 'generation', name: 'geminiGenerateContentCount', docs: 'https://ai.google.dev/api/tokens', path: geminiGenerateContentActionPath('countTokens') }),

  endpoint('embeddings', { group: 'media', name: 'openAiEmbeddings', docs: `${openAi}/embeddings/create` }),
  endpoint('imagesGenerations', { group: 'media', name: 'openAiImageGeneration', docs: `${openAi}/images/create` }),
  endpoint('imagesEdits', { group: 'media', name: 'openAiImageEdit', docs: `${openAi}/images/createEdit` }),
  endpoint('audioTranscriptions', { group: 'media', name: 'openAiTranscription', docs: `${openAi}/audio/createTranscription` }),

  endpoint('cohereV1Rerank', { group: 'rerank', name: 'cohereV1Rerank', docs: 'https://docs.cohere.com/reference/rerank' }),
  endpoint('cohereV2Rerank', { group: 'rerank', name: 'cohereV2Rerank', docs: 'https://docs.cohere.com/v2/reference/rerank' }),
  endpoint('jinaV1Rerank', { group: 'rerank', name: 'jinaRerank', docs: 'https://jina.ai/reranker' }),
  endpoint('voyageV1Rerank', { group: 'rerank', name: 'voyageRerank', docs: 'https://docs.voyageai.com/reference/reranker-api' }),

  endpoint('alphaSearch', { group: 'search', name: 'codexSearch', docs: codexSearchDocs }),
] satisfies readonly ApiDocsEndpoint[];

export const apiDocsGroups = [...new Set(apiDocsEndpoints.map(item => item.group))];
