import { dispatchOpenAIResponses } from './dispatch.ts';
import { openaiResponsesEgressStages } from './egress-stages.ts';
import { stripAuthenticationHeaders } from '../../../pipeline/auth-headers.ts';
import { chatEgressRequest, compose } from '../../pipeline/facts.ts';
import { providerTargets } from '../../pipeline/provider-targets.ts';

export const openaiResponsesEgress = compose('openaiResponses.egress', {
  entry: [...chatEgressRequest, 'openaiResponses'],
  exit: ['http', 'openaiResponses', 'usage', 'usageModelKey?'],
  stages: [...openaiResponsesEgressStages, stripAuthenticationHeaders],
  ending: dispatchOpenAIResponses,
  targets: providerTargets.openaiResponses,
});
