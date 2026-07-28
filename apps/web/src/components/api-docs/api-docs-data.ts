import { PUBLIC_DATA_PLANE_ROUTES, type PublicDataPlaneRouteId } from '@floway-dev/protocols/common';

export type ApiDocsGroup = 'models' | 'generation' | 'media' | 'rerank' | 'search' | 'codex';

export interface ApiDocsEndpoint {
  docs: string;
  group: ApiDocsGroup;
  method: 'GET' | 'POST';
  name: string;
  path: string;
  route: PublicDataPlaneRouteId;
}

const openAi = 'https://platform.openai.com/docs/api-reference';
const codexSearchDocs = 'https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/search.rs#L8-L29';

const endpoint = (
  route: PublicDataPlaneRouteId,
  pathIndex: number,
  metadata: Pick<ApiDocsEndpoint, 'docs' | 'group' | 'name'> & { path?: string },
): ApiDocsEndpoint => {
  const manifest = PUBLIC_DATA_PLANE_ROUTES[route];
  const registeredPath = (manifest.paths as readonly string[])[pathIndex];
  if (registeredPath === undefined) throw new Error(`Public route ${route} has no path at index ${pathIndex}`);
  return { route, method: manifest.method, path: metadata.path ?? registeredPath, ...metadata };
};

const geminiActionPath = (action: string) =>
  PUBLIC_DATA_PLANE_ROUTES.geminiAction.paths[0].replace(':modelAction{.+}', `{model}:${action}`);

export const authCurlExample = (origin: string) => `curl "${origin}/v1/models" \\
  -H "Authorization: Bearer $FLOWAY_API_KEY"`;

export const apiDocsEndpoints: readonly ApiDocsEndpoint[] = [
  endpoint('models', 0, { group: 'models', name: 'openAiModels', docs: `${openAi}/models/list` }),
  endpoint('models', 1, { group: 'models', name: 'openAiModelsAlias', docs: `${openAi}/models/list` }),
  endpoint('geminiModels', 0, { group: 'models', name: 'geminiModels', docs: 'https://ai.google.dev/api/models' }),
  endpoint('geminiModel', 0, { group: 'models', name: 'geminiModel', docs: 'https://ai.google.dev/api/models', path: PUBLIC_DATA_PLANE_ROUTES.geminiModel.paths[0].replace(':modelId{.+}', '{model}') }),

  endpoint('completions', 0, { group: 'generation', name: 'openAiCompletions', docs: `${openAi}/completions/create` }),
  endpoint('completions', 1, { group: 'generation', name: 'openAiCompletionsAlias', docs: `${openAi}/completions/create` }),
  endpoint('chatCompletions', 0, { group: 'generation', name: 'openAiChat', docs: `${openAi}/chat/create` }),
  endpoint('chatCompletions', 1, { group: 'generation', name: 'openAiChatAlias', docs: `${openAi}/chat/create` }),
  endpoint('responses', 0, { group: 'generation', name: 'openAiResponses', docs: `${openAi}/responses/create` }),
  endpoint('responses', 1, { group: 'generation', name: 'openAiResponsesAlias', docs: `${openAi}/responses/create` }),
  endpoint('responsesCompact', 0, { group: 'generation', name: 'openAiCompact', docs: `${openAi}/responses/compact` }),
  endpoint('responsesCompact', 1, { group: 'generation', name: 'openAiCompactAlias', docs: `${openAi}/responses/compact` }),
  endpoint('responsesWebSocket', 0, { group: 'generation', name: 'openAiResponsesWs', docs: 'https://developers.openai.com/api/docs/guides/websocket-mode' }),
  endpoint('responsesWebSocket', 1, { group: 'generation', name: 'openAiResponsesWsAlias', docs: 'https://developers.openai.com/api/docs/guides/websocket-mode' }),
  endpoint('messages', 0, { group: 'generation', name: 'anthropicMessages', docs: 'https://docs.anthropic.com/en/api/messages' }),
  endpoint('messages', 1, { group: 'generation', name: 'anthropicMessagesAlias', docs: 'https://docs.anthropic.com/en/api/messages' }),
  endpoint('messagesCountTokens', 0, { group: 'generation', name: 'anthropicCount', docs: 'https://docs.anthropic.com/en/api/messages-count-tokens' }),
  endpoint('messagesCountTokens', 1, { group: 'generation', name: 'anthropicCountAlias', docs: 'https://docs.anthropic.com/en/api/messages-count-tokens' }),
  endpoint('geminiAction', 0, { group: 'generation', name: 'geminiGenerate', docs: 'https://ai.google.dev/api/generate-content', path: geminiActionPath('generateContent') }),
  endpoint('geminiAction', 0, { group: 'generation', name: 'geminiStream', docs: 'https://ai.google.dev/api/generate-content', path: geminiActionPath('streamGenerateContent') }),
  endpoint('geminiAction', 0, { group: 'generation', name: 'geminiCount', docs: 'https://ai.google.dev/api/tokens', path: geminiActionPath('countTokens') }),

  endpoint('embeddings', 0, { group: 'media', name: 'openAiEmbeddings', docs: `${openAi}/embeddings/create` }),
  endpoint('embeddings', 1, { group: 'media', name: 'openAiEmbeddingsAlias', docs: `${openAi}/embeddings/create` }),
  endpoint('imagesGenerations', 0, { group: 'media', name: 'openAiImageGeneration', docs: `${openAi}/images/create` }),
  endpoint('imagesGenerations', 1, { group: 'media', name: 'openAiImageGenerationAlias', docs: `${openAi}/images/create` }),
  endpoint('imagesEdits', 0, { group: 'media', name: 'openAiImageEdit', docs: `${openAi}/images/createEdit` }),
  endpoint('imagesEdits', 1, { group: 'media', name: 'openAiImageEditAlias', docs: `${openAi}/images/createEdit` }),
  endpoint('audioTranscriptions', 0, { group: 'media', name: 'openAiTranscription', docs: `${openAi}/audio/createTranscription` }),

  endpoint('cohereV1Rerank', 0, { group: 'rerank', name: 'cohereV1Rerank', docs: 'https://docs.cohere.com/reference/rerank' }),
  endpoint('cohereV2Rerank', 0, { group: 'rerank', name: 'cohereV2Rerank', docs: 'https://docs.cohere.com/v2/reference/rerank' }),
  endpoint('jinaV1Rerank', 0, { group: 'rerank', name: 'jinaRerank', docs: 'https://jina.ai/reranker' }),
  endpoint('voyageV1Rerank', 0, { group: 'rerank', name: 'voyageRerank', docs: 'https://docs.voyageai.com/reference/reranker-api' }),

  endpoint('alphaSearch', 0, { group: 'search', name: 'codexSearch', docs: codexSearchDocs }),
  endpoint('alphaSearch', 1, { group: 'search', name: 'codexSearchV1', docs: codexSearchDocs }),

  endpoint('codexAlphaSearch', 0, { group: 'codex', name: 'codexNamespaceSearch', docs: codexSearchDocs }),
  endpoint('codexResponses', 0, { group: 'codex', name: 'codexNamespaceResponses', docs: `${openAi}/responses/create` }),
  endpoint('codexResponsesCompact', 0, { group: 'codex', name: 'codexNamespaceCompact', docs: `${openAi}/responses/compact` }),
  endpoint('codexResponsesWebSocket', 0, { group: 'codex', name: 'codexNamespaceWs', docs: 'https://developers.openai.com/api/docs/guides/websocket-mode' }),
  endpoint('codexImagesGenerations', 0, { group: 'codex', name: 'codexNamespaceImageGeneration', docs: `${openAi}/images/create` }),
  endpoint('codexImagesEdits', 0, { group: 'codex', name: 'codexNamespaceImageEdit', docs: `${openAi}/images/createEdit` }),
  endpoint('codexModels', 0, { group: 'codex', name: 'codexNamespaceModels', docs: `${openAi}/models/list` }),
];

export const apiDocsGroups = [...new Set(apiDocsEndpoints.map(item => item.group))];

export interface ApiDocsExample {
  code: string;
  language: 'bash' | 'json';
  title: string;
}

export const apiDocsExamples = {
  completions: { title: 'completions', language: 'json', code: '{\n  "model": "MODEL_ID",\n  "prompt": "Hello"\n}' },
  chat: { title: 'chat', language: 'json', code: '{\n  "model": "MODEL_ID",\n  "messages": [{ "role": "user", "content": "Hello" }]\n}' },
  responses: { title: 'responses', language: 'json', code: '{\n  "model": "MODEL_ID",\n  "input": "Hello",\n  "stream": true\n}' },
  messages: { title: 'messages', language: 'json', code: '{\n  "model": "MODEL_ID",\n  "max_tokens": 1024,\n  "messages": [{ "role": "user", "content": "Hello" }]\n}' },
  gemini: { title: 'gemini', language: 'json', code: '{\n  "contents": [{ "role": "user", "parts": [{ "text": "Hello" }] }]\n}' },
  embeddings: { title: 'embeddings', language: 'json', code: '{\n  "model": "MODEL_ID",\n  "input": ["First document", "Second document"]\n}' },
  imageGeneration: { title: 'imageGeneration', language: 'json', code: '{\n  "model": "MODEL_ID",\n  "prompt": "A glass city at sunrise"\n}' },
  imageEdit: { title: 'imageEdit', language: 'json', code: '{\n  "model": "MODEL_ID",\n  "prompt": "Add a rainbow",\n  "images": [{ "image_url": "https://example.com/input.png" }]\n}' },
  audio: { title: 'audio', language: 'bash', code: 'curl "$FLOWAY_BASE_URL/v1/audio/transcriptions" \\\n  -H "Authorization: Bearer $FLOWAY_API_KEY" \\\n  -F "model=MODEL_ID" \\\n  -F "file=@speech.mp3"' },
  rerank: { title: 'rerank', language: 'json', code: '{\n  "model": "MODEL_ID",\n  "query": "What is Floway?",\n  "documents": ["Document one", "Document two"]\n}' },
  search: { title: 'search', language: 'json', code: '{\n  "commands": {\n    "search_query": [{ "q": "latest LLM gateway news" }]\n  }\n}' },
  websocket: { title: 'websocket', language: 'json', code: '{\n  "type": "response.create",\n  "response": { "model": "MODEL_ID", "input": "Hello" }\n}' },
} as const satisfies Record<string, ApiDocsExample>;

export type ApiDocsExampleId = keyof typeof apiDocsExamples;
