import { dispatchAnthropicMessages } from './dispatch.ts';
import { anthropicMessagesEgressStages } from './egress-stages.ts';
import { stripAuthenticationHeaders } from '../../../pipeline/auth-headers.ts';
import { chatEgressRequest, compose } from '../../pipeline/facts.ts';
import { providerTargets } from '../../pipeline/provider-targets.ts';

export const anthropicMessagesEgress = compose('anthropicMessages.egress', {
  entry: [...chatEgressRequest, 'anthropicMessages'],
  exit: ['http', 'anthropicMessages', 'usage', 'usageModelKey?'],
  stages: [...anthropicMessagesEgressStages, stripAuthenticationHeaders],
  ending: dispatchAnthropicMessages,
  targets: providerTargets.anthropicMessages,
});
