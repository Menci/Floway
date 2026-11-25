import { gatewayFactSpace, type GatewayPipelineFacts, type ProtocolResponseKey } from '../pipeline/facts.ts';
import { move } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();

export const normalizeDamagedUpstreamResponse = <const Key extends ProtocolResponseKey>(responseKey: Key) => {
  const through = {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['response.http', responseKey], provides: ['response.http'], consumes: [] },
  } as const;
  const define = defineStage<typeof through>;
  type Answer = Awaited<ReturnType<Parameters<typeof define>[0]['execute']>>;

  return define({
    name: 'serve.normalize-damaged-upstream-response',
    through,
    async execute(facts, scope) {
      const response = await scope.next(facts);
      const http = response['response.http'];
      const outcome = response[responseKey] as GatewayPipelineFacts[Key];
      if (http === null || http.status < 200 || http.status >= 300 || outcome.kind !== 'error' || outcome.source !== 'upstream') {
        return response as Answer;
      }
      return { ...response, 'response.http': move({ ...http, status: 502, statusText: 'Bad Gateway' }) } as Answer;
    },
  });
};
