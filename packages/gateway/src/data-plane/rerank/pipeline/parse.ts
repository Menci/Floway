import { gatewayFactSpace } from '../../pipeline/facts.ts';
import { jsonResponseBody, responseHead } from '../../pipeline/response.ts';
import { readHttpBody } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import type { RerankSourceProtocol } from '@floway-dev/protocols/common';
import { formatRerankError, parseRerankRequest } from '@floway-dev/protocols/rerank';

const { defineStage } = gatewayFactSpace<{}>();

export const rerankError = (status: number, message: string) => ({
  'response.http': move(responseHead(status)),
  'response.rerank': move({ kind: 'error', source: 'local', error: formatRerankError(status, message) } as const),
});

const invalid = (message: string) => ({ 'response.http': move(jsonResponseBody(responseHead(400), formatRerankError(400, message))) });

export const parseRerank = (protocol: RerankSourceProtocol) => defineStage({
  name: 'rerank.parse-request',
  through: {
    request: { needs: ['request.http'], provides: ['request.rerank', 'request.delivery', 'serve.model'], consumes: [] },
    response: { needs: ['response.http'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http'] },
  async execute(facts, scope) {
    const raw = await readHttpBody(facts['request.http'].body);
    if (!raw.ok) return invalid('Rerank request body must be valid JSON');
    const text = new TextDecoder().decode(raw.value);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return invalid('Rerank request body must be valid JSON');
    }

    const parsed = parseRerankRequest(protocol, body);
    if (!parsed.ok) return invalid(parsed.error);
    const { request, model } = parsed.value;
    return await scope.next({
      ...facts,
      'request.delivery': move({ kind: 'rerank', protocol, request }),
      'request.rerank': move(request),
      'serve.model': model,
    });
  },
});
