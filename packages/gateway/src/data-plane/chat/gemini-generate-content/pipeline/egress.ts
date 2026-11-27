import { dispatchGeminiGenerateContent } from './dispatch.ts';
import { geminiGenerateContentEgressStages } from './egress-stages.ts';
import { stripAuthenticationHeaders } from '../../../pipeline/auth-headers.ts';
import { chatEgressRequest, compose } from '../../pipeline/facts.ts';
import { providerTargets } from '../../pipeline/provider-targets.ts';

export const geminiGenerateContentEgress = compose('geminiGenerateContent.egress', {
  entry: [...chatEgressRequest, 'geminiGenerateContent'],
  exit: ['http', 'geminiGenerateContent', 'usage'],
  stages: [...geminiGenerateContentEgressStages, stripAuthenticationHeaders],
  ending: dispatchGeminiGenerateContent,
  targets: providerTargets.geminiGenerateContent,
});
