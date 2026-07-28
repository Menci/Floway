import { PUBLIC_DATA_PLANE_ROUTES, type PublicDataPlaneRouteId } from '@floway-dev/protocols/common';

export type ApiDocsGroup = 'models' | 'generation' | 'media' | 'rerank' | 'search';

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
  metadata: Pick<ApiDocsEndpoint, 'docs' | 'group' | 'name'> & { path?: string },
): ApiDocsEndpoint => {
  const manifest = PUBLIC_DATA_PLANE_ROUTES[route];
  return { route, method: manifest.method, path: metadata.path ?? manifest.paths.join(', '), ...metadata };
};

const geminiActionPath = (action: string) =>
  PUBLIC_DATA_PLANE_ROUTES.geminiAction.paths[0].replace(':modelAction{.+}', `{model}:${action}`);

export const authCurlExample = (origin: string) => `curl "${origin}/v1/models" \\
  -H "Authorization: Bearer $FLOWAY_API_KEY"`;

export const apiDocsEndpoints: readonly ApiDocsEndpoint[] = [
  endpoint('models', { group: 'models', name: 'openAiModels', docs: `${openAi}/models/list` }),
  endpoint('geminiModels', { group: 'models', name: 'geminiModels', docs: 'https://ai.google.dev/api/models' }),
  endpoint('geminiModel', { group: 'models', name: 'geminiModel', docs: 'https://ai.google.dev/api/models', path: PUBLIC_DATA_PLANE_ROUTES.geminiModel.paths[0].replace(':modelId{.+}', '{model}') }),

  endpoint('completions', { group: 'generation', name: 'openAiCompletions', docs: `${openAi}/completions/create` }),
  endpoint('chatCompletions', { group: 'generation', name: 'openAiChat', docs: `${openAi}/chat/create` }),
  endpoint('responses', { group: 'generation', name: 'openAiResponses', docs: `${openAi}/responses/create` }),
  endpoint('responsesCompact', { group: 'generation', name: 'openAiCompact', docs: `${openAi}/responses/compact` }),
  endpoint('responsesWebSocket', { group: 'generation', name: 'openAiResponsesWs', docs: 'https://developers.openai.com/api/docs/guides/websocket-mode' }),
  endpoint('messages', { group: 'generation', name: 'anthropicMessages', docs: 'https://docs.anthropic.com/en/api/messages' }),
  endpoint('messagesCountTokens', { group: 'generation', name: 'anthropicCount', docs: 'https://docs.anthropic.com/en/api/messages-count-tokens' }),
  endpoint('geminiAction', { group: 'generation', name: 'geminiGenerate', docs: 'https://ai.google.dev/api/generate-content', path: geminiActionPath('generateContent') }),
  endpoint('geminiAction', { group: 'generation', name: 'geminiStream', docs: 'https://ai.google.dev/api/generate-content', path: geminiActionPath('streamGenerateContent') }),
  endpoint('geminiAction', { group: 'generation', name: 'geminiCount', docs: 'https://ai.google.dev/api/tokens', path: geminiActionPath('countTokens') }),

  endpoint('embeddings', { group: 'media', name: 'openAiEmbeddings', docs: `${openAi}/embeddings/create` }),
  endpoint('imagesGenerations', { group: 'media', name: 'openAiImageGeneration', docs: `${openAi}/images/create` }),
  endpoint('imagesEdits', { group: 'media', name: 'openAiImageEdit', docs: `${openAi}/images/createEdit` }),
  endpoint('audioTranscriptions', { group: 'media', name: 'openAiTranscription', docs: `${openAi}/audio/createTranscription` }),

  endpoint('cohereV1Rerank', { group: 'rerank', name: 'cohereV1Rerank', docs: 'https://docs.cohere.com/reference/rerank' }),
  endpoint('cohereV2Rerank', { group: 'rerank', name: 'cohereV2Rerank', docs: 'https://docs.cohere.com/v2/reference/rerank' }),
  endpoint('jinaV1Rerank', { group: 'rerank', name: 'jinaRerank', docs: 'https://jina.ai/reranker' }),
  endpoint('voyageV1Rerank', { group: 'rerank', name: 'voyageRerank', docs: 'https://docs.voyageai.com/reference/reranker-api' }),

  endpoint('alphaSearch', { group: 'search', name: 'codexSearch', docs: codexSearchDocs }),
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
