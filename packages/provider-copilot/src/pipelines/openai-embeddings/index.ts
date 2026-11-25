import { copilotOperation } from '../facts.ts';
import { parseOpenAIEmbeddings } from './parse.ts';
import { serializeOpenAIEmbeddings } from './serialize.ts';
import { wrapScalarInput } from './wrap-scalar-input.ts';
import { authorize } from '../shared/authorize.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { selectModel } from '../shared/select-model.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { formatOpenAIChatCompletionsError } from '@floway-dev/protocols/openai-chat-completions';
import { httpTerminal } from '@floway-dev/provider';

export const openaiEmbeddings = copilotOperation<'openaiEmbeddings'>().compose('copilot.openaiEmbeddings', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.openaiEmbeddings'],
  exit: ['response.http', 'response.modelKey', 'response.openaiEmbeddings'],
  stages: [
    stripClientHeaders,
    selectModel('openaiEmbeddings', 'response.openaiEmbeddings', formatOpenAIChatCompletionsError),
    setIdentityHeaders,
    wrapScalarInput,
    serializeOpenAIEmbeddings,
    observeQuota,
    authorize('response.openaiEmbeddings', formatOpenAIChatCompletionsError),
    parseOpenAIEmbeddings,
  ],
  ending: httpTerminal,
});
