import { gatewayFactSpace } from '../../pipeline/facts.ts';
import { jsonResponseBody, responseHead } from '../../pipeline/response.ts';
import { readHttpBody } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import type { RerankSourceProtocol } from '@floway-dev/protocols/common';
import { formatRerankError, parseRerankRequest, type ParsedRerankRequest } from '@floway-dev/protocols/rerank';

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
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw.value));
    } catch {
      return invalid('Rerank request body must be valid JSON');
    }

    let parsed: ParsedRerankRequest;
    try {
      parsed = parseRerankRequest(protocol, body);
    } catch (error) {
      return invalid(error instanceof Error ? error.message : String(error));
    }
    return await scope.next({
      ...facts,
      'request.delivery': move({ kind: 'rerank', protocol, request: parsed.request }),
      'request.rerank': move(parsed.request),
      'serve.model': parsed.model,
    });
  },
});
