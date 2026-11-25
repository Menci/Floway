import { copilotOperation } from '../facts.ts';
import { parseOpenAIImagesEdits } from './parse.ts';
import { serializeOpenAIImagesEdits } from './serialize.ts';
import { authorize } from '../shared/authorize.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { selectModel } from '../shared/select-model.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { formatOpenAIChatCompletionsError } from '@floway-dev/protocols/openai-chat-completions';
import { httpTerminal } from '@floway-dev/provider';

export const openaiImagesEdits = copilotOperation<'openaiImagesEdits'>().compose('copilot.openaiImagesEdits', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.openaiImagesEdits'],
  exit: ['response.http', 'response.modelKey', 'response.openaiImagesEdits'],
  stages: [
    stripClientHeaders,
    selectModel('openaiImagesEdits', 'response.openaiImagesEdits', formatOpenAIChatCompletionsError),
    setIdentityHeaders,
    serializeOpenAIImagesEdits,
    observeQuota,
    authorize('response.openaiImagesEdits', formatOpenAIChatCompletionsError),
    parseOpenAIImagesEdits,
  ],
  ending: httpTerminal,
});
