import { dial } from './dial.ts';
import { selectModel } from './select-model.ts';
import { copilotOperation } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { readJsonObject } from '../shared/read-json-object.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { decodeOpenAIImagesEditsStream } from '@floway-dev/protocols/openai-images';
import { httpTerminal, parseHttpResponse } from '@floway-dev/provider';

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
  exit: ['response.http', 'response.openaiImagesEdits', 'response.usageModelKey?'],
  stages: [
    stripClientHeaders,
    selectModel,
    setIdentityHeaders,
    parse,
    authorize(operation, formatOpenAIError),
    dial,
    observeQuota,
  ],
  ending: httpTerminal,
});
