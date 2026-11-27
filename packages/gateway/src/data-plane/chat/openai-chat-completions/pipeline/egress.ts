import { dispatchOpenAIChatCompletions } from './dispatch.ts';
import { openaiChatCompletionsEgressStages } from './egress-stages.ts';
import { stripAuthenticationHeaders } from '../../../pipeline/auth-headers.ts';
import { chatEgressRequest, compose } from '../../pipeline/facts.ts';
import { providerTargets } from '../../pipeline/provider-targets.ts';

export const openaiChatCompletionsEgress = compose('openaiChatCompletions.egress', {
  entry: [...chatEgressRequest, 'openaiChatCompletions'],
  exit: ['http', 'openaiChatCompletions', 'usage', 'usageModelKey?'],
  stages: [...openaiChatCompletionsEgressStages, stripAuthenticationHeaders],
  ending: dispatchOpenAIChatCompletions,
  targets: providerTargets.openaiChatCompletions,
});
