import { geminiGenerateContentCountTokensPipeline } from './count-tokens.ts';
import { geminiGenerateContentGeneratePipeline } from './generate.ts';
import { routeGeminiGenerateContentAction } from './route-action.ts';
import { gatewayFactSpace, httpEntry } from '../../../pipeline/facts.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';

const { compose } = gatewayFactSpace<GatewayServices>();

export const geminiGenerateContentPipeline = compose('geminiGenerateContent.ingress', {
  entry: httpEntry,
  exit: ['response.http'],
  stages: [],
  ending: routeGeminiGenerateContentAction,
  targets: { generate: geminiGenerateContentGeneratePipeline, countTokens: geminiGenerateContentCountTokensPipeline },
});
