import { copilotRequestHeaders } from '../auth.ts';
import { copilotOpenAIEmbeddingsBody, rawModelFor } from '../operation-model.ts';
import type { CopilotHttpFacts, CopilotOperation, CopilotRequest } from '../pipeline-facts.ts';
import type { HttpResponseFacts } from '@floway-dev/http/pipeline';
import type { HttpBody, HttpBodyEncoding } from '@floway-dev/http/request-content';
import { defineStage, isSecret, move, secret, type Secret } from '@floway-dev/pipeline';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest } from '@floway-dev/protocols/decision';
import { prepareOpenAIImagesEditsBody, withHttpContentType, type ProviderOperationPayloads, type ProviderResponse, type ProviderServices } from '@floway-dev/provider';

interface PreparedCopilotRequest {
  readonly path: string;
  readonly body: HttpBody;
  readonly encoding: HttpBodyEncoding;
}

// The image endpoints advertise `/v1/...` paths and only answer there: the
// unprefixed `/images/edits` the other data-plane surfaces use returns a bare
// `404 page not found`. `/v1/images/generations` accepts JSON only, while
// `/v1/images/edits` accepts JSON references and multipart uploads; it refuses
// a `reference` carrying a remote URL with `400 external image URLs are not
// supported`, which reaches the client as Copilot's own answer.
// Decision models answer at the path each one advertises in
// `supported_endpoints`, in that model's own dialect.
const prepareBody = async <O extends CopilotOperation>(
  operation: O,
  model: CopilotRequest<O>['request.provider.model'],
  payload: ProviderOperationPayloads[O],
  modelKey: string,
): Promise<PreparedCopilotRequest> => {
  switch (operation) {
  case 'openaiEmbeddings':
    return { path: '/embeddings', body: { ...copilotOpenAIEmbeddingsBody(payload as ProviderOperationPayloads['openaiEmbeddings']), model: modelKey }, encoding: 'json' };
  case 'openaiImagesGenerations':
    return { path: '/v1/images/generations', body: { ...(payload as ProviderOperationPayloads['openaiImagesGenerations']), model: modelKey }, encoding: 'json' };
  case 'openaiImagesEdits':
    return { path: '/v1/images/edits', ...await prepareOpenAIImagesEditsBody(payload as ProviderOperationPayloads['openaiImagesEdits'], modelKey) };
  case 'decision': {
    const target = model.decisionTarget;
    if (target === undefined) throw new Error(`Decision model ${model.id} has no outbound target`);
    return {
      path: target.path ?? DEFAULT_DECISION_PATHS[target.protocol],
      body: serializeDecisionRequest(target.protocol, modelKey, payload as ProviderOperationPayloads['decision']),
      encoding: 'json',
    };
  }
  default:
    throw new Error(`Copilot has no pipeline for ${String(operation)}`);
  }
};

export const prepareCopilotRequest = <O extends CopilotOperation>(operation: O) => {
  const prepare = defineStage<CopilotRequest<O>, CopilotHttpFacts, HttpResponseFacts, ProviderResponse, ProviderServices>({
    name: `prepareCopilot${operation.replace(/^openai/, 'OpenAI').replace(/^decision/, 'Decision')}`,
    through: {
      request: {
        needs: ['request.provider.model', 'request.provider.payload', 'request.http.headers', 'request.http.callId', 'request.copilot.session'],
        consumes: ['request.provider.model', 'request.provider.payload', 'request.copilot.session', 'request.http.headers'],
        provides: ['request.http.url', 'request.http.method', 'request.http.headers', 'request.http.body', 'request.http.encoding', 'request.copilot.modelKey'],
      },
      response: { needs: ['response.http.exchange'], consumes: [], provides: ['response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls'] },
    },
    execute: async (facts, next) => {
      const { 'request.provider.model': model, 'request.provider.payload': payload, 'request.copilot.session': session, ...rest } = facts;
      const modelKey = rawModelFor(model, operation).id;
      const prepared = await prepareBody(operation, model, payload, modelKey);
      const admitted = facts['request.http.headers'].map(([name, value]): [string, string] => [name, isSecret(value) ? value.reveal() : value]);
      const identity = [...copilotRequestHeaders({ ...session, token: session.token.reveal() }, undefined, admitted)]
        .map(([name, value]): [string, string | Secret<string>] => [name, name === 'authorization' ? secret(value) : value]);
      const back = await next(move({
        ...rest,
        'request.copilot.modelKey': modelKey,
        'request.http.url': `${session.baseUrl}${prepared.path}`,
        'request.http.method': 'POST',
        'request.http.headers': withHttpContentType(identity, prepared.body, prepared.encoding),
        'request.http.body': prepared.body,
        'request.http.encoding': prepared.encoding,
      }));
      return move({ ...back, 'response.provider.modelKey': modelKey, 'response.provider.called': back['response.http.exchange'].type === 'response', 'response.provider.previousCalls': [] });
    },
  });
  return prepare;
};
