import { applyTopLevelCacheControl } from './apply-top-level-cache-control.ts';
import { compressImages } from './compress-images.ts';
import { dial } from './dial.ts';
import { handleSpeedFast } from './handle-speed-fast.ts';
import { normalizeAnthropicBeta } from './normalize-anthropic-beta.ts';
import { parse } from './parse.ts';
import { promoteThinkingDisplay } from './promote-thinking-display.ts';
import { rewriteContextWindowError } from './rewrite-context-window-error.ts';
import { selectModel } from './select-model.ts';
import { setClaudeAgentHeaders } from './set-claude-agent-headers.ts';
import { setCompactHeaders } from './set-compact-headers.ts';
import { setInitiatorHeader } from './set-initiator-header.ts';
import { setInteractionIdHeader } from './set-interaction-id-header.ts';
import { setVisionHeader } from './set-vision-header.ts';
import { stripCacheControlExtensions } from './strip-cache-control-extensions.ts';
import { stripAnthropicMessagesClientHeaders } from './strip-client-headers.ts';
import { stripEagerInputStreaming } from './strip-eager-input-streaming.ts';
import type { CopilotServices } from '../../service.ts';
import { composeCopilot } from '../facts.ts';
import { authorize } from '../shared/authorize.ts';
import { setIdentityHeaders } from '../shared/set-identity-headers.ts';
import { httpTerminal, type UpstreamPipeline } from '@floway-dev/upstream';

export const anthropicMessages: UpstreamPipeline<'anthropicMessages', CopilotServices, 'usageModelKey'> = composeCopilot('copilot.anthropicMessages', {
  entry: ['http', 'upstream', 'model', 'anthropicMessages'],
  exit: ['http', 'anthropicMessages', 'usageModelKey?'],
  stages: [
    stripAnthropicMessagesClientHeaders,
    selectModel,
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
    parse,
    dial,
    authorize,
  ],
  ending: httpTerminal,
});
