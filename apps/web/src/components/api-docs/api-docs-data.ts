export interface ApiDocsEndpoint {
  docs: string;
  group: string;
  method: 'GET' | 'POST';
  name: string;
  path: string;
}

const openAi = 'https://platform.openai.com/docs/api-reference';
const codexSearchDocs = 'https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/search.rs#L8-L29';

export const authCurlExample = (origin: string) => `curl "${origin}/v1/models" \\\n  -H "Authorization: Bearer $FLOWAY_API_KEY"`;

export const apiDocsEndpoints = [
  { group: 'models', method: 'GET', path: '/v1/models', name: 'openAiModels', docs: `${openAi}/models/list` },
  { group: 'models', method: 'GET', path: '/models', name: 'openAiModelsAlias', docs: `${openAi}/models/list` },
  { group: 'models', method: 'GET', path: '/v1beta/models', name: 'geminiModels', docs: 'https://ai.google.dev/api/models' },
  { group: 'models', method: 'GET', path: '/v1beta/models/{model}', name: 'geminiModel', docs: 'https://ai.google.dev/api/models' },

  { group: 'generation', method: 'POST', path: '/v1/completions', name: 'openAiCompletions', docs: `${openAi}/completions/create` },
  { group: 'generation', method: 'POST', path: '/completions', name: 'openAiCompletionsAlias', docs: `${openAi}/completions/create` },
  { group: 'generation', method: 'POST', path: '/v1/chat/completions', name: 'openAiChat', docs: `${openAi}/chat/create` },
  { group: 'generation', method: 'POST', path: '/chat/completions', name: 'openAiChatAlias', docs: `${openAi}/chat/create` },
  { group: 'generation', method: 'POST', path: '/v1/responses', name: 'openAiResponses', docs: `${openAi}/responses/create` },
  { group: 'generation', method: 'POST', path: '/responses', name: 'openAiResponsesAlias', docs: `${openAi}/responses/create` },
  { group: 'generation', method: 'POST', path: '/v1/responses/compact', name: 'openAiCompact', docs: `${openAi}/responses/compact` },
  { group: 'generation', method: 'POST', path: '/responses/compact', name: 'openAiCompactAlias', docs: `${openAi}/responses/compact` },
  { group: 'generation', method: 'GET', path: '/v1/responses', name: 'openAiResponsesWs', docs: 'https://developers.openai.com/api/docs/guides/websocket-mode' },
  { group: 'generation', method: 'GET', path: '/responses', name: 'openAiResponsesWsAlias', docs: 'https://developers.openai.com/api/docs/guides/websocket-mode' },
  { group: 'generation', method: 'POST', path: '/v1/messages', name: 'anthropicMessages', docs: 'https://docs.anthropic.com/en/api/messages' },
  { group: 'generation', method: 'POST', path: '/messages', name: 'anthropicMessagesAlias', docs: 'https://docs.anthropic.com/en/api/messages' },
  { group: 'generation', method: 'POST', path: '/v1/messages/count_tokens', name: 'anthropicCount', docs: 'https://docs.anthropic.com/en/api/messages-count-tokens' },
  { group: 'generation', method: 'POST', path: '/messages/count_tokens', name: 'anthropicCountAlias', docs: 'https://docs.anthropic.com/en/api/messages-count-tokens' },
  { group: 'generation', method: 'POST', path: '/v1beta/models/{model}:generateContent', name: 'geminiGenerate', docs: 'https://ai.google.dev/api/generate-content' },
  { group: 'generation', method: 'POST', path: '/v1beta/models/{model}:streamGenerateContent', name: 'geminiStream', docs: 'https://ai.google.dev/api/generate-content' },
  { group: 'generation', method: 'POST', path: '/v1beta/models/{model}:countTokens', name: 'geminiCount', docs: 'https://ai.google.dev/api/tokens' },

  { group: 'media', method: 'POST', path: '/v1/embeddings', name: 'openAiEmbeddings', docs: `${openAi}/embeddings/create` },
  { group: 'media', method: 'POST', path: '/embeddings', name: 'openAiEmbeddingsAlias', docs: `${openAi}/embeddings/create` },
  { group: 'media', method: 'POST', path: '/v1/images/generations', name: 'openAiImageGeneration', docs: `${openAi}/images/create` },
  { group: 'media', method: 'POST', path: '/images/generations', name: 'openAiImageGenerationAlias', docs: `${openAi}/images/create` },
  { group: 'media', method: 'POST', path: '/v1/images/edits', name: 'openAiImageEdit', docs: `${openAi}/images/createEdit` },
  { group: 'media', method: 'POST', path: '/images/edits', name: 'openAiImageEditAlias', docs: `${openAi}/images/createEdit` },
  { group: 'media', method: 'POST', path: '/v1/audio/transcriptions', name: 'openAiTranscription', docs: `${openAi}/audio/createTranscription` },

  { group: 'rerank', method: 'POST', path: '/v1/rerank', name: 'cohereV1Rerank', docs: 'https://docs.cohere.com/reference/rerank' },
  { group: 'rerank', method: 'POST', path: '/v2/rerank', name: 'cohereV2Rerank', docs: 'https://docs.cohere.com/v2/reference/rerank' },
  { group: 'rerank', method: 'POST', path: '/jina/v1/rerank', name: 'jinaRerank', docs: 'https://jina.ai/reranker' },
  { group: 'rerank', method: 'POST', path: '/voyage/v1/rerank', name: 'voyageRerank', docs: 'https://docs.voyageai.com/reference/reranker-api' },

  { group: 'search', method: 'POST', path: '/alpha/search', name: 'codexSearch', docs: codexSearchDocs },
  { group: 'search', method: 'POST', path: '/v1/alpha/search', name: 'codexSearchV1', docs: codexSearchDocs },

  { group: 'codex', method: 'POST', path: '/azure-api.codex/alpha/search', name: 'codexNamespaceSearch', docs: codexSearchDocs },
  { group: 'codex', method: 'POST', path: '/azure-api.codex/responses', name: 'codexNamespaceResponses', docs: `${openAi}/responses/create` },
  { group: 'codex', method: 'POST', path: '/azure-api.codex/responses/compact', name: 'codexNamespaceCompact', docs: `${openAi}/responses/compact` },
  { group: 'codex', method: 'GET', path: '/azure-api.codex/responses', name: 'codexNamespaceWs', docs: 'https://developers.openai.com/api/docs/guides/websocket-mode' },
  { group: 'codex', method: 'POST', path: '/azure-api.codex/images/generations', name: 'codexNamespaceImageGeneration', docs: `${openAi}/images/create` },
  { group: 'codex', method: 'POST', path: '/azure-api.codex/images/edits', name: 'codexNamespaceImageEdit', docs: `${openAi}/images/createEdit` },
  { group: 'codex', method: 'GET', path: '/azure-api.codex/models', name: 'codexNamespaceModels', docs: `${openAi}/models/list` },
] as const satisfies readonly ApiDocsEndpoint[];

export type ApiDocsGroup = typeof apiDocsEndpoints[number]['group'];
export const apiDocsGroups = [...new Set(apiDocsEndpoints.map(endpoint => endpoint.group))];

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
