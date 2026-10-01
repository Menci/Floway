import type { GatewayFacts } from './facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';

export const serializeClientJson = <K extends string>(renderedKey: K) => defineStage<
  Record<string, never>,
  Record<string, never>,
  Record<K, unknown>,
  Pick<GatewayFacts, 'response.http.jsonBody'>
>({
  name: 'serializeClientJson',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: [renderedKey], consumes: [], provides: ['response.http.jsonBody'] },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const rendered = back[renderedKey];
    if (typeof rendered === 'object' && rendered !== null
      && (rendered instanceof Uint8Array || Symbol.asyncIterator in rendered)) {
      return move({ ...back, 'response.http.jsonBody': null });
    }
    const json = JSON.stringify(rendered);
    if (json === undefined) throw new TypeError('Client JSON body has no JSON representation');
    return move({ ...back, 'response.http.jsonBody': new TextEncoder().encode(json) });
  },
});
