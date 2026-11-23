import { applyCopilotTopLevelCacheControl } from './apply-top-level-cache-control.ts';
import { compressCopilotAnthropicMessagesImages } from './compress-images.ts';
import { parseUserIdMetadata } from './detect-claude-code-metadata.ts';
import { handleSpeedFast, requireFastMode } from './handle-speed-fast.ts';
import { normalizeCopilotAnthropicBeta } from './normalize-anthropic-beta.ts';
import { omitPromotedThinkingTextFromProtocolFrames, promoteCopilotThinkingDisplay } from './promote-thinking-display.ts';
import { rewriteContextWindowError } from './rewrite-context-window-error.ts';
import { copilotClaudeAgentHeaderOverrides } from './set-claude-agent-headers.ts';
import { applyCopilotCompactHeaders, classifyCopilotCompact } from './set-compact-headers.ts';
import { copilotSessionUuid } from './set-interaction-id-header.ts';
import { copilotAnthropicContentHasImage } from './set-vision-header.ts';
import { stripCopilotCacheControlExtensions } from './strip-cache-control-extensions.ts';
import { stripCopilotEagerInputStreaming } from './strip-eager-input-streaming.ts';
import type { CopilotUpstreamFacts } from '../../config.ts';
import { CONTEXT_1M_BETA } from '../../model-selection.ts';
import { headerStage, payloadStage, selectModelStage, withPublicModel } from '../shared/stages.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { deleteHeader, headersForAnthropicMessagesCall, setHeader, type ProviderAnthropicInput, type ProviderAnthropicMessagesOutput } from '@floway-dev/provider';

type Input = ProviderAnthropicInput<CopilotUpstreamFacts>;
type Output = ProviderAnthropicMessagesOutput;

const selectAnthropicModel = (generation: boolean) => selectModelStage<Input>(
  'anthropicMessages', ['request.payload', 'request.anthropicBeta'],
  facts => ({
    context1m: facts['request.anthropicBeta'].includes(CONTEXT_1M_BETA),
    reasoningEffort: facts['request.payload'].output_config?.effort ?? undefined,
    fast: generation && facts['request.payload'].speed === 'fast',
  }),
);

const setCompactHeaders = headerStage<Input>('set-compact-headers', ['request.payload'], (facts, headers) =>
  applyCopilotCompactHeaders(classifyCopilotCompact(facts['request.payload']), headers));

const setClaudeAgentHeaders = headerStage<Input>('set-claude-agent-headers', ['request.payload', 'provider.model'], (facts, headers) => {
  const overrides = copilotClaudeAgentHeaderOverrides(withPublicModel(facts));
  if (overrides === null) return headers;
  return Object.entries(overrides).reduce((current, [name, value]) =>
    value === '' ? deleteHeader(current, name) : setHeader(current, name, value), headers);
});

const setInteractionIdHeader = headerStage<Input>('set-interaction-id-header', ['request.payload'], async (facts, headers) => {
  const { sessionId } = parseUserIdMetadata(facts['request.payload'].metadata?.user_id ?? undefined);
  return sessionId ? setHeader(headers, 'x-interaction-id', await copilotSessionUuid(sessionId)) : deleteHeader(headers, 'x-interaction-id');
});

const setVisionHeader = headerStage<Input>('set-vision-header', ['request.payload'], (facts, headers) => {
  if (facts['request.payload'].messages.some(message => copilotAnthropicContentHasImage(message.content))) {
    return setHeader(headers, 'copilot-vision-request', 'true');
  }
  return deleteHeader(headers, 'copilot-vision-request');
});

// https://github.com/caozhiyuan/copilot-api/blob/88840ed80000635902b90a35989b1e795d289fdf/src/services/copilot/create-messages.ts
const setInitiatorHeader = headerStage<Input>('set-initiator-header', ['request.payload'], (facts, headers) => {
  const last = facts['request.payload'].messages.at(-1);
  const user = last?.role === 'user'
    && (!Array.isArray(last.content) || last.content.some(block => block.type !== 'tool_result'));
  return setHeader(headers, 'x-initiator', user ? 'user' : 'agent');
});

const setAnthropicBetaHeader = headerStage<Input>('normalize-anthropic-beta', ['request.payload', 'request.anthropicBeta', 'provider.model'], (facts, headers) => {
  const beta = normalizeCopilotAnthropicBeta(facts['request.anthropicBeta'], withPublicModel(facts));
  return headersForAnthropicMessagesCall(headers, beta);
});

const promoteThinkingDisplay = defineStage<Input, Input, Output, Output>({
  name: 'promote-thinking-display',
  through: {
    request: { needs: ['request.payload', 'provider.model'], consumes: [], provides: ['request.payload'] },
    response: { needs: ['response.anthropicMessages'], consumes: [], provides: ['response.anthropicMessages'] },
  },
  async execute(facts, scope) {
    const promoted = promoteCopilotThinkingDisplay(withPublicModel(facts));
    const { model: _model, ...payload } = promoted.payload;
    const back = await scope.next({ ...facts, 'request.payload': payload });
    const outcome = back['response.anthropicMessages'];
    if (!promoted.omitThinkingText || outcome.kind !== 'stream') return back;
    const events = scope.wrapStream(outcome.events, { label: 'anthropic.thinking-display', transform: omitPromotedThinkingTextFromProtocolFrames });
    return { ...back, 'response.anthropicMessages': { ...outcome, events } };
  },
});

const compressImages = payloadStage<AnthropicMessagesPayload>('compress-images', compressCopilotAnthropicMessagesImages);
const finalHeaders = [setVisionHeader, setInitiatorHeader, setAnthropicBetaHeader];

export const anthropicMessagesStages = [
  requireFastMode,
  selectAnthropicModel(true),
  rewriteContextWindowError,
  setCompactHeaders,
  setClaudeAgentHeaders,
  setInteractionIdHeader,
  compressImages,
  handleSpeedFast,
  promoteThinkingDisplay,
  payloadStage<AnthropicMessagesPayload>('apply-top-level-cache-control', applyCopilotTopLevelCacheControl),
  payloadStage<AnthropicMessagesPayload>('strip-cache-control-extensions', stripCopilotCacheControlExtensions),
  payloadStage<AnthropicMessagesPayload>('strip-eager-input-streaming', stripCopilotEagerInputStreaming),
  ...finalHeaders,
];

export const anthropicCountTokensStages = [
  selectAnthropicModel(false),
  compressImages,
  ...finalHeaders,
];
