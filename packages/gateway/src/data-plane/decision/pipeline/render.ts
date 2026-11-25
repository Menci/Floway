import type { ProtocolRenderer } from '../../pipeline/encode-response.ts';
import { jsonResponseBody } from '../../pipeline/response.ts';
import { renderDecisionResponse } from '@floway-dev/protocols/decision';

export const renderDecision: ProtocolRenderer<'response.decision'> = ({ result }, http, delivery) => {
  if (delivery.kind !== 'decision') throw new TypeError('Decision needs the client dialect');
  const body = delivery.protocol === result.targetProtocol ? result.raw : renderDecisionResponse(delivery.protocol, result);
  return jsonResponseBody(http, body);
};
