import { geminiGenerateContentRpcErrorPayload } from './errors.ts';
import type { GeminiIngressInput } from './ingress.ts';
import { type HttpOutput, jsonHttpResponse } from '../../pipeline/edge-http.ts';
import { GATEWAY_HTTP_ENTRY, type GatewayHttpFacts } from '../../pipeline/host.ts';
import { localHttpAnswer, type RenderFacts } from '../../pipeline/render.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { compose, defineEnding, type StaticTarget, type ThroughDecl } from '@floway-dev/pipeline';

type Action = GeminiIngressInput['request.geminiAction'];
type Response = HttpOutput & RenderFacts;
type ActionIngress = StaticTarget<GeminiIngressInput, Response, GatewayServices>;
type Targets = { readonly generate: ActionIngress; readonly count: ActionIngress };
const exit = ['response.http', 'response.render'] as const;

const decodeModelAction = (encoded: string): string => {
  try {
    return decodeURIComponent(encoded);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return encoded;
  }
};

const actionFromPath = (pathname: string): Action | string => {
  const modelAction = decodeModelAction(pathname.replace(/^\/v1(?:beta)?\/models\//, ''));
  if (modelAction === '') return 'Missing Gemini model action.';
  const separator = modelAction.lastIndexOf(':');
  if (separator <= 0 || separator === modelAction.length - 1) return `Unknown Gemini model action: ${modelAction}`;
  const action = modelAction.slice(separator + 1);
  if (action !== 'countTokens' && action !== 'generateContent' && action !== 'streamGenerateContent') return `Unknown Gemini model action: ${action}`;
  return { action, model: modelAction.slice(0, separator).replace(/^models\//, '') };
};

const actionSlot: ThroughDecl = {
  request: { needs: [], consumes: [], provides: ['request.geminiAction'] },
  response: { needs: exit, consumes: [], provides: [] },
};

const routeAction = defineEnding<GatewayHttpFacts, Response, Targets>({
  name: 'routeAction',
  request: { needs: ['request.http'] },
  into: { generate: actionSlot, count: actionSlot },
  return: { provides: exit },
  execute: async (facts, scope) => {
    const action = actionFromPath(facts['request.http'].url.pathname);
    if (typeof action === 'string') return localHttpAnswer(scope, jsonHttpResponse(404, geminiGenerateContentRpcErrorPayload(404, action), scope.clock()));
    const input = { ...facts, 'request.geminiAction': action };
    return action.action === 'countTokens' ? await scope.into.count(input) : await scope.into.generate(input);
  },
});

export const createGeminiGenerateContentRoute = (targets: Targets) =>
  compose<GatewayHttpFacts & Response, GatewayServices>()('gemini.route', {
    entry: GATEWAY_HTTP_ENTRY, exit,
    stages: [], ending: routeAction, targets,
  });
