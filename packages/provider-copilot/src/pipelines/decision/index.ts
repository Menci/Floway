import { copilotOperation } from '../facts.ts';
import { parseDecision } from './parse.ts';
import { serializeDecision } from './serialize.ts';
import { authorize } from '../shared/authorize.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { selectModel } from '../shared/select-model.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripClientHeaders } from '../shared/strip-client-headers.ts';
import { formatOpenAIChatCompletionsError } from '@floway-dev/protocols/openai-chat-completions';
import { httpTerminal } from '@floway-dev/provider';

export const decision = copilotOperation<'decision'>().compose('copilot.decision', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.decision'],
  exit: ['response.http', 'response.modelKey', 'response.decision'],
  stages: [
    stripClientHeaders,
    selectModel('decision', 'response.decision', formatOpenAIChatCompletionsError),
    setIdentityHeaders,
    serializeDecision,
    observeQuota,
    authorize('response.decision', formatOpenAIChatCompletionsError),
    parseDecision,
  ],
  ending: httpTerminal,
});
