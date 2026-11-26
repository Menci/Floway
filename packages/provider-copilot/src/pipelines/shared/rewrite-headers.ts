import { defineCopilotStage } from '../facts.ts';
import type { HttpHeaders } from '@floway-dev/http';
import type { GatewayFacts, ProviderOperation } from '@floway-dev/provider';

type HeaderRewrite<Op extends ProviderOperation> = (
  payload: GatewayFacts[`request.${Op}`],
  headers: HttpHeaders,
  model: GatewayFacts['provider.model'],
) => HttpHeaders | Promise<HttpHeaders>;

export const rewriteHeaders = <const Op extends ProviderOperation>(operation: Op, name: string, rewrite: HeaderRewrite<NoInfer<Op>>) => {
  const request = `request.${operation}` as const;
  return defineCopilotStage({
    name: `copilot.${operation}.${name}`,
    through: {
      request: { needs: [request, 'request.http', 'provider.model'], provides: ['request.http'], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      const inputs = facts as Pick<GatewayFacts, typeof request | 'request.http' | 'provider.model'>;
      const http = inputs['request.http'];
      const headers = await rewrite(inputs[request], http.headers, inputs['provider.model']);
      const downstream = headers === http.headers ? facts : { ...facts, 'request.http': { ...http, headers } };
      // The generic request key appears unchanged in the declared input and handoff.
      return await scope.next(downstream as Parameters<typeof scope.next>[0]);
    },
  });
};
