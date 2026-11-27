import { compressImages } from './compress-images.ts';
import { dial } from './dial.ts';
import { normalizeAnthropicBeta } from './normalize-anthropic-beta.ts';
import { parse } from './parse.ts';
import { selectModel } from './select-model.ts';
import { setInitiatorHeader } from './set-initiator-header.ts';
import { setVisionHeader } from './set-vision-header.ts';
import type { CopilotServices } from '../../service.ts';
import { stripAnthropicMessagesClientHeaders } from '../anthropic-messages/strip-client-headers.ts';
import { composeCopilot } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { httpTerminal, type UpstreamPipeline } from '@floway-dev/upstream';

export const anthropicMessagesCountTokens: UpstreamPipeline<'anthropicMessagesCountTokens', CopilotServices> = composeCopilot('copilot.anthropicMessagesCountTokens', {
  entry: ['http', 'upstream', 'model', 'anthropicMessagesCountTokens'],
  exit: ['http', 'anthropicMessagesCountTokens'],
  stages: [
    stripAnthropicMessagesClientHeaders,
    selectModel,
    setIdentityHeaders,
    compressImages,
    setVisionHeader,
    setInitiatorHeader,
    normalizeAnthropicBeta,
    parse,
    dial,
    authorize,
  ],
  ending: httpTerminal,
});
