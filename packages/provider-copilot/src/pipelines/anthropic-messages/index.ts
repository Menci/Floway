import { copilotOperation } from '../facts.ts';
import { applyTopLevelCacheControl } from './apply-top-level-cache-control.ts';
import { compressImages } from './compress-images.ts';
import { handleSpeedFast } from './handle-speed-fast.ts';
import { normalizeAnthropicBeta } from './normalize-anthropic-beta.ts';
import { parseAnthropicMessages } from './parse.ts';
import { promoteThinkingDisplay } from './promote-thinking-display.ts';
import { rewriteContextWindowError } from './rewrite-context-window-error.ts';
import { selectAnthropicMessagesModel } from './select-model.ts';
import { serializeAnthropicMessages } from './serialize.ts';
import { setClaudeAgentHeaders } from './set-claude-agent-headers.ts';
import { setCompactHeaders } from './set-compact-headers.ts';
import { setInitiatorHeader } from './set-initiator-header.ts';
import { setInteractionIdHeader } from './set-interaction-id-header.ts';
import { setVisionHeader } from './set-vision-header.ts';
import { stripCacheControlExtensions } from './strip-cache-control-extensions.ts';
import { stripEagerInputStreaming } from './strip-eager-input-streaming.ts';
import { authorize } from '../shared/authorize.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripAnthropicMessagesClientHeaders } from '../shared/strip-client-headers.ts';
import { formatAnthropicMessagesError } from '@floway-dev/protocols/anthropic-messages';
import { httpTerminal } from '@floway-dev/provider';

export const anthropicMessages = copilotOperation<'anthropicMessages'>().compose('copilot.anthropicMessages', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.anthropicMessages'],
  exit: ['response.http', 'response.modelKey', 'response.anthropicMessages'],
  stages: [
    stripAnthropicMessagesClientHeaders,
    selectAnthropicMessagesModel(true),
    setIdentityHeaders,
    rewriteContextWindowError,
    setCompactHeaders,
    setClaudeAgentHeaders,
    setInteractionIdHeader,
    compressImages,
    handleSpeedFast,
    promoteThinkingDisplay,
    applyTopLevelCacheControl,
    stripCacheControlExtensions,
    stripEagerInputStreaming,
    setVisionHeader,
    setInitiatorHeader,
    normalizeAnthropicBeta,
    serializeAnthropicMessages,
    observeQuota,
    authorize('response.anthropicMessages', formatAnthropicMessagesError),
    parseAnthropicMessages,
  ],
  ending: httpTerminal,
});
