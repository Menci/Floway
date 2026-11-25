import { gatewayFactSpace } from '../../pipeline/facts.ts';
import { jsonResponseBody, responseHead } from '../../pipeline/response.ts';
import { readHttpBody } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import { parseJSONWithRawNumbers, type DecisionProtocol } from '@floway-dev/protocols/common';
import { formatDecisionError, parseDecisionRequest } from '@floway-dev/protocols/decision';

const { defineStage } = gatewayFactSpace<{}>();

export const decisionError = (status: number, message: string) => ({
  'response.http': move(responseHead(status)),
  'response.decision': move({ kind: 'error', source: 'local', error: formatDecisionError(status, message) } as const),
});

const invalid = (message: string) => ({ 'response.http': move(jsonResponseBody(responseHead(400), formatDecisionError(400, message))) });

export const parseDecision = (protocol: DecisionProtocol) => defineStage({
  name: 'decision.parse-request',
  through: {
    request: { needs: ['request.http'], provides: ['request.decision', 'request.delivery', 'serve.model'], consumes: [] },
    response: { needs: ['response.http'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http'] },
  async execute(facts, scope) {
    const raw = await readHttpBody(facts['request.http'].body);
    if (!raw.ok) return invalid('Decision request body must be valid JSON');
    const text = new TextDecoder().decode(raw.value);
    let body: unknown;
    try {
      body = parseJSONWithRawNumbers(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return invalid('Decision request body must be valid JSON');
    }

    const parsed = parseDecisionRequest(protocol, body);
    if (!parsed.ok) return invalid(parsed.error);
    const { request, model } = parsed.value;
    return await scope.next({
      ...facts,
      'request.delivery': move({ kind: 'decision', protocol }),
      'request.decision': move(request),
      'serve.model': model,
    });
  },
});
