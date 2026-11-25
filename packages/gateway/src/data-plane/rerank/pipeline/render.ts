import type { ProtocolRenderer } from '../../pipeline/encode-response.ts';
import { jsonResponseBody } from '../../pipeline/response.ts';
import { renderRerankResponse } from '@floway-dev/protocols/rerank';

export const renderRerank: ProtocolRenderer<'response.rerank'> = ({ result }, http, delivery) => {
  if (delivery.kind !== 'rerank') throw new TypeError('Rerank needs the client dialect');
  return jsonResponseBody(http, renderRerankResponse(delivery.protocol, result.targetProtocol, result, delivery.request));
};
