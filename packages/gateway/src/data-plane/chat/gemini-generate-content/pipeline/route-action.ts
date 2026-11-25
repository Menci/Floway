import { geminiGenerateContentHttpError } from './parse-request.ts';
import { gatewayFactSpace, httpEntry } from '../../../pipeline/facts.ts';
import { move } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();
const actionFacts = ['serve.model', 'request.delivery'] as const;
export const geminiGenerateContentActionEntry = [...httpEntry, ...actionFacts] as const;

const action = {
  request: { needs: httpEntry, provides: actionFacts, consumes: [] },
  response: { needs: ['response.http'], provides: [], consumes: [] },
} as const;

export const routeGeminiGenerateContentAction = defineStage({
  name: 'geminiGenerateContent.route-action',
  request: { needs: httpEntry },
  into: { generate: action, countTokens: action },
  return: { provides: ['response.http'] },
  async execute(facts, scope) {
    const url = new URL(facts['request.http'].url);
    const path = /^\/v1(?:beta)?\/models\/(.+)$/.exec(url.pathname)?.[1];
    if (path === undefined) return geminiGenerateContentHttpError(404, 'Missing Gemini model action.');
    const modelAction = decodeURIComponent(path);
    const separator = modelAction.lastIndexOf(':');
    if (separator <= 0 || separator === modelAction.length - 1) return geminiGenerateContentHttpError(404, `Unknown Gemini model action: ${modelAction}`);
    const model = modelAction.slice(0, separator).replace(/^models\//, '');
    const name = modelAction.slice(separator + 1);
    const request = { ...facts, 'serve.model': model };

    if (name === 'countTokens') return await scope.into.countTokens({ ...request, 'request.delivery': move({ kind: 'json' } as const) });
    if (name === 'generateContent' || name === 'streamGenerateContent') return await scope.into.generate({
      ...request,
      'request.delivery': move({ kind: 'geminiGenerateContent', stream: name === 'streamGenerateContent' } as const),
    });
    return geminiGenerateContentHttpError(404, `Unknown Gemini model action: ${name}`);
  },
});
