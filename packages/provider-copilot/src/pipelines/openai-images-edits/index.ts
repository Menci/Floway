import { copilotOperation } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { dial } from '../shared/dial.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { readJsonObject } from '../shared/read-json-object.ts';
import { selectModel } from '../shared/select-model.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { decodeOpenAIImagesEditsStream } from '@floway-dev/protocols/openai-images';
import { httpTerminal, parseHttpResponse, serializeOpenAIImagesEditsBody } from '@floway-dev/provider';

const operation = 'openaiImagesEdits';

const parse = parseHttpResponse(operation, {
  select(payload) {
    const stream = payload.parameters.stream;
    return stream === true || stream === 'true' ? 'stream' : 'result';
  },
  stream: decodeOpenAIImagesEditsStream,
  result: readJsonObject,
  format: formatOpenAIError,
});

export const openaiImagesEdits = copilotOperation<typeof operation>().compose('copilot.openaiImagesEdits', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.openaiImagesEdits'],
  exit: ['response.http', 'response.openaiImagesEdits'],
  stages: [
    stripClientHeaders,
    selectModel.openaiImagesEdits,
    setIdentityHeaders,
    parse,
    authorize(operation, formatOpenAIError),
    dial.openaiImagesEdits(async payload => {
      const model = payload.parameters.model;
      if (typeof model !== 'string') throw new TypeError('Copilot image edits requires a selected model');
      const { model: _model, ...parameters } = payload.parameters;
      return { path: '/v1/images/edits', ...await serializeOpenAIImagesEditsBody({ ...payload, parameters }, model) };
    }, formatOpenAIError),
    observeQuota,
  ],
  ending: httpTerminal,
});
