import type { CopilotServices } from '../../service.ts';
import { defineCopilotStage } from '../facts.ts';
import type { GatewayFacts, ProviderOperation } from '@floway-dev/provider';

type Payload<Op extends ProviderOperation> = GatewayFacts[`request.${Op}`];
type PayloadRewrite<Op extends ProviderOperation> = (
  payload: Payload<Op>,
  model: GatewayFacts['provider.model'],
  services: Readonly<CopilotServices>,
) => Payload<Op> | Promise<Payload<Op>>;

export const rewritePayload = <const Op extends ProviderOperation>(operation: Op, name: string, rewrite: PayloadRewrite<NoInfer<Op>>) => {
  const request = `request.${operation}` as const;
  return defineCopilotStage({
    name: `copilot.${operation}.${name}`,
    through: {
      request: { needs: [request, 'provider.model'], provides: [request], consumes: [] },
      response: { needs: [], provides: [], consumes: [] },
    },
    async execute(facts, scope) {
      const inputs = facts as Pick<GatewayFacts, typeof request | 'provider.model'>;
      const current = inputs[request];
      const payload = await rewrite(current, inputs['provider.model'], scope.services);
      return await scope.next(payload === current ? facts : { ...facts, [request]: payload });
    },
  });
};
