import { geminiGenerateContentRpcErrorPayload } from './errors.ts';
import type { GeminiIngressInput } from './ingress.ts';
import { answerKeys, gatewayAnswer } from '../../pipeline/answer.ts';
import { type HttpOutput, jsonHttpResponse } from '../../pipeline/edge-http.ts';
import type { GatewayHttpFacts } from '../../pipeline/host.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import type { SettlementFacts } from '../../pipeline/settlement.ts';
import { compose, defineEnding, type StaticTarget, type ThroughDecl } from '@floway-dev/pipeline';

type Action = GeminiIngressInput['request.geminiAction'];
type ActionIngress = StaticTarget<GeminiIngressInput, HttpOutput & SettlementFacts, GatewayServices>;
type Targets = { readonly generate: ActionIngress; readonly count: ActionIngress };

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
  response: { needs: ['response.http', 'response.source', 'response.settlement'], consumes: [], provides: [] },
};

const routeAction = defineEnding<GatewayHttpFacts, HttpOutput & Partial<SettlementFacts>, Targets>({
  name: 'routeAction',
  request: { needs: ['request.http'] },
  into: { generate: actionSlot, count: actionSlot },
  return: { provides: answerKeys },
  execute: async (facts, into, env) => {
    const action = actionFromPath(facts['request.http'].url.pathname);
    if (typeof action === 'string') return gatewayAnswer(env, jsonHttpResponse(404, geminiGenerateContentRpcErrorPayload(404, action), env.clock()));
    const input = { ...facts, 'request.geminiAction': action };
    return action.action === 'countTokens' ? await into.count(input) : await into.generate(input);
  },
});

export const createGeminiGenerateContentRoute = (targets: Targets) =>
  compose<GatewayHttpFacts, HttpOutput & Partial<SettlementFacts>, GatewayServices, Targets>('gemini.route', {
    stages: [], ending: routeAction, targets,
  });
