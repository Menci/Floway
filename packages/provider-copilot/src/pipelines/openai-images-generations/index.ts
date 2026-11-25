import { copilotOperation } from '../facts.ts';
import { parseOpenAIImagesGenerations } from './parse.ts';
import { serializeOpenAIImagesGenerations } from './serialize.ts';
import { authorize } from '../shared/authorize.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { selectModel } from '../shared/select-model.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { formatOpenAIChatCompletionsError } from '@floway-dev/protocols/openai-chat-completions';
import { httpTerminal } from '@floway-dev/provider';

export const openaiImagesGenerations = copilotOperation<'openaiImagesGenerations'>().compose('copilot.openaiImagesGenerations', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.openaiImagesGenerations'],
  exit: ['response.http', 'response.modelKey', 'response.openaiImagesGenerations'],
  stages: [
    stripClientHeaders,
    selectModel('openaiImagesGenerations'),
    setIdentityHeaders,
    serializeOpenAIImagesGenerations,
    observeQuota,
    authorize('response.openaiImagesGenerations', formatOpenAIChatCompletionsError),
    parseOpenAIImagesGenerations,
  ],
  ending: httpTerminal,
});
