import { wrapScalarInput } from './wrap-scalar-input.ts';
import { copilotOperation } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { dial, jsonRequest } from '../shared/dial.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { readJsonObject } from '../shared/read-json-object.ts';
import { selectModel } from '../shared/select-model.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { httpTerminal, parseResultResponse } from '@floway-dev/provider';

const operation = 'openaiEmbeddings';

export const openaiEmbeddings = copilotOperation<typeof operation>().compose('copilot.openaiEmbeddings', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.openaiEmbeddings'],
  exit: ['response.http', 'response.openaiEmbeddings', 'response.usageModelKey?'],
  stages: [
    stripClientHeaders,
    selectModel.openaiEmbeddings,
    setIdentityHeaders,
    wrapScalarInput,
    parseResultResponse(operation, readJsonObject, formatOpenAIError),
    authorize(operation, formatOpenAIError),
    dial.openaiEmbeddings(payload => jsonRequest('/embeddings', payload), formatOpenAIError),
    observeQuota,
  ],
  ending: httpTerminal,
});
