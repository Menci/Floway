import { applyTopLevelCacheControl } from './apply-top-level-cache-control.ts';
import { compressImages } from './compress-images.ts';
import { dial } from './dial.ts';
import { handleSpeedFast } from './handle-speed-fast.ts';
import { normalizeAnthropicBeta } from './normalize-anthropic-beta.ts';
import { promoteThinkingDisplay } from './promote-thinking-display.ts';
import { rewriteContextWindowError } from './rewrite-context-window-error.ts';
import { selectModel } from './select-model.ts';
import { setClaudeAgentHeaders } from './set-claude-agent-headers.ts';
import { setCompactHeaders } from './set-compact-headers.ts';
import { setInitiatorHeader } from './set-initiator-header.ts';
import { setInteractionIdHeader } from './set-interaction-id-header.ts';
import { setVisionHeader } from './set-vision-header.ts';
import { stripCacheControlExtensions } from './strip-cache-control-extensions.ts';
import { stripEagerInputStreaming } from './strip-eager-input-streaming.ts';
import { copilotOperation } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { formatAnthropicMessagesError } from '../shared/format-errors.ts';
import { observeQuota } from '../shared/observe-quota.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { stripAnthropicMessagesClientHeaders } from '../shared/strip-client-headers.ts';
import { decodeAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { httpTerminal, parseSseResponse } from '@floway-dev/provider';

const operation = 'anthropicMessages';

export const anthropicMessages = copilotOperation<typeof operation>().compose('copilot.anthropicMessages', {
  entry: ['request.http', 'provider.upstream', 'provider.model', 'request.anthropicMessages'],
  exit: ['response.http', 'response.anthropicMessages', 'response.usageModelKey?'],
  stages: [
    stripAnthropicMessagesClientHeaders,
    selectModel,
    setIdentityHeaders,
    rewriteContextWindowError,
    setCompactHeaders,
    setClaudeAgentHeaders,
    setInteractionIdHeader,
    compressImages(operation),
    handleSpeedFast,
    promoteThinkingDisplay,
    applyTopLevelCacheControl,
    stripCacheControlExtensions,
    stripEagerInputStreaming,
    setVisionHeader(operation),
    setInitiatorHeader(operation),
    normalizeAnthropicBeta(operation),
    parseSseResponse(operation, decodeAnthropicMessagesStream, formatAnthropicMessagesError),
    authorize(operation, formatAnthropicMessagesError),
    dial,
    observeQuota,
  ],
  ending: httpTerminal,
});
