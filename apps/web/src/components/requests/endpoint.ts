import { apiDocsEndpoints } from '../api-docs/data';
import { PUBLIC_DATA_PLANE_ROUTES, type PublicDataPlaneRouteId } from '@floway-dev/protocols/browser';

/** A key of `apiDocs.endpointNames`: the name the API docs give an endpoint. */
export type EndpointName = (typeof apiDocsEndpoints)[number]['name'];

// The Codex-addressed routes serve the protocols of their public twins.
const CODEX_TWINS: Partial<Record<PublicDataPlaneRouteId, PublicDataPlaneRouteId>> = {
  codexAlphaSearch: 'alphaSearch',
  codexOpenAIResponses: 'openaiResponses',
  codexOpenAIResponsesCompact: 'openaiResponsesCompact',
  codexOpenAIResponsesWebSocket: 'openaiResponsesWebSocket',
  codexOpenAIImagesGenerations: 'openaiImagesGenerations',
  codexOpenAIImagesEdits: 'openaiImagesEdits',
  codexModels: 'models',
};

// One Gemini route carries three endpoints, told apart by the action after the
// model id.
const GEMINI_ACTIONS: Record<string, EndpointName> = {
  generateContent: 'geminiGenerateContentGenerate',
  streamGenerateContent: 'geminiGenerateContentStream',
  countTokens: 'geminiGenerateContentCount',
};

// Route paths are Hono patterns: `:name{regex}` takes its own expression and
// a bare `:name` one segment.
const toRegExp = (pattern: string) => new RegExp(`^${pattern.split('/').map(segment => {
  const custom = /^:\w+\{(.+)\}$/.exec(segment);
  if (custom) return custom[1];
  if (segment.startsWith(':')) return '[^/]+';
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}).join('/')}$`);

const routes = (Object.entries(PUBLIC_DATA_PLANE_ROUTES) as Array<[PublicDataPlaneRouteId, (typeof PUBLIC_DATA_PLANE_ROUTES)[PublicDataPlaneRouteId]]>)
  .map(([id, manifest]) => ({ id, method: manifest.method as string, patterns: manifest.paths.map(toRegExp) }));

const namesByRoute = new Map<PublicDataPlaneRouteId, EndpointName>(
  apiDocsEndpoints
    .filter(endpoint => endpoint.route !== 'geminiGenerateContentAction')
    .map(endpoint => [endpoint.route, endpoint.name]),
);

/**
 * The endpoint a captured request addressed, by the name the API docs list it
 * under, or null for a path no public route serves.
 */
export const endpointName = (method: string, path: string): EndpointName | null => {
  const bare = path.split('?')[0]!;
  const route = routes.find(candidate => candidate.method === method.toUpperCase() && candidate.patterns.some(pattern => pattern.test(bare)));
  if (!route) return null;
  const id = CODEX_TWINS[route.id] ?? route.id;
  if (id === 'geminiGenerateContentAction') return GEMINI_ACTIONS[bare.slice(bare.lastIndexOf(':') + 1)] ?? null;
  return namesByRoute.get(id) ?? null;
};
