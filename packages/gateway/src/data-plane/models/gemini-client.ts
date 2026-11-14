// Gemini's API accepts both `v1beta` and `v1` for the same REST surface, and
// every official SDK labels its requests with the same library id. The current
// SDKs write `google-genai-sdk/<version>` to both telemetry headers:
//
// https://github.com/googleapis/js-genai/blob/8892aeace095b90805890e0fd5cfa027d87bbc70/src/_api_client.ts#L18-L21
// https://github.com/googleapis/js-genai/blob/8892aeace095b90805890e0fd5cfa027d87bbc70/src/_api_client.ts#L884-L894
// https://github.com/googleapis/python-genai/blob/ccd5dd32b14b119f7d3a3254541add6db493222c/google/genai/_api_client.py#L145-L171
// https://github.com/googleapis/go-genai/blob/9517de6ac48304ba9d0aa9914dbdc1373e7c0aae/api_client.go#L270-L323
//
// The deprecated SDKs predate that label and name themselves only in
// `x-goog-api-client` (`genai-js`) or the `genai-py/<version>` user-agent.
//
// https://github.com/google-gemini/deprecated-generative-ai-js/blob/22acc9cd0d75d677c70776e1542034f6a6106677/src/requests/request.ts#L34-L73
// https://github.com/google-gemini/deprecated-generative-ai-python/blob/7a7cc5474ddaa0255a4410e05361028a24400abd/google/generativeai/client.py#L34-L35
const GEMINI_CLIENT_PATTERN = /(?:^|\s)(?:google-genai-sdk|genai-js|genai-py)\//;

// Model discovery answers one wire shape per request, so the shared
// `/v1/models` and `/v1beta/models` routes pick the Gemini shape from the
// caller's own telemetry headers, the same way they already select the Codex,
// Pi, OMP, Claude Code, and TypeSafe catalogs. A Gemini SDK parses
// `{ models: [{ name: 'models/…' }] }`; every other caller keeps the
// OpenAI/Anthropic superset.
export const isGeminiClient = (headers: Headers): boolean =>
  GEMINI_CLIENT_PATTERN.test(`${headers.get('user-agent') ?? ''} ${headers.get('x-goog-api-client') ?? ''}`);
