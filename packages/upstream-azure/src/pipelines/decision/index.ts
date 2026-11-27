import { readAzureUpstreamConfig } from '../../config.ts';
import { azureDecisionUrl } from '../../endpoint.ts';
import { compose, defineStage } from '../fact-space.ts';
import { filterAzureHeaders } from '../filter-headers.ts';
import { azureRequest, jsonBody, parseAzureResult } from '../http.ts';
import { serializeDecisionRequest } from '@floway-dev/protocols/decision';
import { httpTerminal } from '@floway-dev/upstream';

const dial = defineStage({
  name: 'azure.decision.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'decision'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'decision'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { endpoint, apiKey } = readAzureUpstreamConfig(facts.upstream);
    const target = facts.model.decisionTarget;
    if (target === undefined) throw new Error(`Decision model ${facts.model.id} has no outbound target`);
    const url = azureDecisionUrl(endpoint, target.path);
    const body = jsonBody(serializeDecisionRequest(target.protocol, facts.model.upstreamModelId, facts.decision));
    const httpRequest = azureRequest(facts.http, url, apiKey, body);
    const { 'http.error': failure, ...answer } = await scope.next({ ...facts, http: httpRequest });
    const parsed = await parseAzureResult(answer.http, failure, scope, bytes => ({ ok: true, value: bytes }));
    return { ...answer, http: parsed.http, decision: parsed.outcome };
  },
});

export const azureDecisionPipeline = compose('azure.decision', {
  entry: ['http', 'upstream', 'model', 'decision'],
  exit: ['http', 'decision'],
  stages: [filterAzureHeaders, dial],
  ending: httpTerminal,
});
