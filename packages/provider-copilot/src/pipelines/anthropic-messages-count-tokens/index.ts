import { compressImages } from '../anthropic-messages/compress-images.ts';
import { normalizeAnthropicBeta } from '../anthropic-messages/normalize-anthropic-beta.ts';
import { selectAnthropicMessagesModel } from '../anthropic-messages/select-model.ts';
import { setInitiatorHeader } from '../anthropic-messages/set-initiator-header.ts';
import { setVisionHeader } from '../anthropic-messages/set-vision-header.ts';
import { copilotOperation } from '../facts.ts';
import { parseAnthropicMessagesCountTokens } from './parse.ts';
import { serializeAnthropicMessagesCountTokens } from './serialize.ts';
import { authorize } from '../shared/authorize.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripAnthropicMessagesClientHeaders } from '../shared/strip-client-headers.ts';
import { formatAnthropicMessagesError } from '@floway-dev/protocols/anthropic-messages';
import { httpTerminal } from '@floway-dev/provider';

export const anthropicMessagesCountTokens = copilotOperation<'anthropicMessagesCountTokens'>().compose('copilot.anthropicMessagesCountTokens', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.anthropicMessages'],
  exit: ['response.http', 'response.modelKey', 'response.anthropicMessages'],
  stages: [
    stripAnthropicMessagesClientHeaders,
    selectAnthropicMessagesModel(false),
    setIdentityHeaders,
    compressImages,
    setVisionHeader,
    setInitiatorHeader,
    normalizeAnthropicBeta,
    serializeAnthropicMessagesCountTokens,
    observeQuota,
    authorize('response.anthropicMessages', formatAnthropicMessagesError),
    parseAnthropicMessagesCountTokens,
  ],
  ending: httpTerminal,
});
