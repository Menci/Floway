import { appendGeminiThoughtSignature, flushGeminiThoughtSignature, type GeminiThoughtSignatureState, geminiCandidateEvent, parseStrictJsonObject, signGeminiPart } from '../shared/gemini-via/gemini.ts';
import { billableServiceTier, eventFrame, splitInclusiveInputTokens, type ProtocolFrame } from '@floway-dev/protocols/common';
import { GEMINI_USAGE_BILLING, type GeminiFinishReason, type GeminiStreamEvent, type GeminiUsageMetadata } from '@floway-dev/protocols/gemini';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';

const messagesStopReasonToGemini = (stopReason: Extract<MessagesStreamEvent, { type: 'message_delta' }>['delta']['stop_reason']): GeminiFinishReason => {
  switch (stopReason) {
  case 'end_turn':
  case 'tool_use':
  case 'stop_sequence':
    return 'STOP';
  case 'max_tokens':
    return 'MAX_TOKENS';
  case 'refusal':
    return 'SAFETY';
  default:
    return 'OTHER';
  }
};

const UPSTREAM_MESSAGES_MISSING_TERMINAL_MESSAGE = 'Upstream Messages stream ended without a message_stop event.';

const upstreamMessagesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>): AsyncGenerator<MessagesStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (frame.event.type === 'message_stop' || frame.event.type === 'error') {
      return;
    }
  }

  throw new Error(UPSTREAM_MESSAGES_MISSING_TERMINAL_MESSAGE);
};

interface MessagesToolUseDraft {
  id?: string;
  name?: string;
  argsJson: string;
  args?: Record<string, unknown>;
}

interface MessagesToGeminiStreamState extends GeminiThoughtSignatureState {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation5mInputTokens: number;
  cacheCreation1hInputTokens: number;
  hasCacheCreationBreakdown: boolean;
  upstreamSpeed?: string;
  upstreamServiceTier?: string;
  toolUses: Record<number, MessagesToolUseDraft>;
}

// Anthropic's input_tokens excludes cache reads and cache creation; Gemini's
// promptTokenCount is an inclusive total like OpenAI's prompt_tokens. Fold all
// three Anthropic buckets into the Gemini total, then surface cache reads
// separately as cachedContentTokenCount.
const mapUsage = (state: MessagesToGeminiStreamState, usage?: Extract<MessagesStreamEvent, { type: 'message_delta' }>['usage']): GeminiUsageMetadata | undefined => {
  const cacheWriteInputTokens = state.hasCacheCreationBreakdown
    ? state.cacheCreation5mInputTokens
    : state.cacheCreationInputTokens;
  const cacheWriteTotal = cacheWriteInputTokens + state.cacheCreation1hInputTokens;
  const promptTokenCount = state.inputTokens + state.cacheReadInputTokens + cacheWriteTotal;
  const candidatesTokenCount = usage?.output_tokens ?? 0;
  splitInclusiveInputTokens(promptTokenCount, state.cacheReadInputTokens, cacheWriteTotal);
  const serviceTier = billableServiceTier(usage?.speed ?? state.upstreamSpeed)
    ?? billableServiceTier(usage?.service_tier ?? state.upstreamServiceTier);
  if (usage === undefined && promptTokenCount === 0 && serviceTier === null) return undefined;

  return {
    promptTokenCount,
    candidatesTokenCount,
    totalTokenCount: promptTokenCount + candidatesTokenCount,
    ...(state.cacheReadInputTokens > 0 ? { cachedContentTokenCount: state.cacheReadInputTokens } : {}),
    ...(cacheWriteInputTokens > 0 || state.cacheCreation1hInputTokens > 0 || serviceTier !== null
      ? {
          [GEMINI_USAGE_BILLING]: {
            ...(cacheWriteInputTokens > 0 ? { cacheWriteTokenCount: cacheWriteInputTokens } : {}),
            ...(state.cacheCreation1hInputTokens > 0 ? { cacheWrite1hTokenCount: state.cacheCreation1hInputTokens } : {}),
            ...(serviceTier !== null ? { serviceTier } : {}),
          },
        }
      : {}),
  };
};

const throwOnMessagesFatalEvent = (event: MessagesStreamEvent): void => {
  if (event.type !== 'error') return;

  throw new Error(`Upstream Messages stream error: ${event.error.type}: ${event.error.message}`, { cause: event });
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const state: MessagesToGeminiStreamState = {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    hasCacheCreationBreakdown: false,
    toolUses: {},
  };

  for await (const event of upstreamMessagesEventsUntilTerminal(frames)) {
    throwOnMessagesFatalEvent(event);

    switch (event.type) {
    case 'message_start':
      state.inputTokens = event.message.usage.input_tokens;
      state.cacheReadInputTokens = event.message.usage.cache_read_input_tokens ?? 0;
      state.cacheCreationInputTokens = event.message.usage.cache_creation_input_tokens ?? 0;
      if (event.message.usage.cache_creation !== undefined) {
        state.hasCacheCreationBreakdown = true;
        state.cacheCreation5mInputTokens = event.message.usage.cache_creation.ephemeral_5m_input_tokens ?? 0;
        state.cacheCreation1hInputTokens = event.message.usage.cache_creation.ephemeral_1h_input_tokens ?? 0;
      }
      state.upstreamSpeed = event.message.usage.speed;
      state.upstreamServiceTier = event.message.usage.service_tier;
      break;

    case 'content_block_start':
      if (event.content_block.type === 'tool_use') {
        state.toolUses[event.index] = {
          id: event.content_block.id,
          name: event.content_block.name,
          argsJson: '',
          args: event.content_block.input,
        };
        break;
      }

      if (event.content_block.type === 'redacted_thinking') {
        appendGeminiThoughtSignature(state, event.content_block.data);
        break;
      }

      if (event.content_block.type === 'thinking' && event.content_block.thinking.length > 0) {
        yield eventFrame(
          geminiCandidateEvent([
            {
              text: event.content_block.thinking,
              thought: true,
            },
          ]),
        );
        break;
      }

      if (event.content_block.type === 'text' && event.content_block.text.length > 0) {
        yield eventFrame(geminiCandidateEvent([signGeminiPart(state, { text: event.content_block.text })]));
      }
      break;

    case 'content_block_delta':
      switch (event.delta.type) {
      case 'thinking_delta':
        if (event.delta.thinking.length > 0) {
          yield eventFrame(geminiCandidateEvent([{ text: event.delta.thinking, thought: true }]));
        }
        break;
      case 'signature_delta':
        appendGeminiThoughtSignature(state, event.delta.signature);
        break;
      case 'text_delta':
        if (event.delta.text.length > 0) {
          yield eventFrame(geminiCandidateEvent([signGeminiPart(state, { text: event.delta.text })]));
        }
        break;
      case 'input_json_delta':
        if (state.toolUses[event.index]) {
          state.toolUses[event.index].argsJson += event.delta.partial_json;
        }
        break;
      default:
        break;
      }
      break;

    case 'content_block_stop': {
      const toolUse = state.toolUses[event.index];
      if (toolUse) {
        delete state.toolUses[event.index];
        if (!toolUse.name) {
          throw new Error('Messages tool use ended without a name.');
        }

        yield eventFrame(
          geminiCandidateEvent([
            signGeminiPart(state, {
              functionCall: {
                ...(toolUse.id !== undefined ? { id: toolUse.id } : {}),
                name: toolUse.name,
                args: toolUse.argsJson ? parseStrictJsonObject(toolUse.argsJson, 'Messages tool use input') : toolUse.args ?? {},
              },
            }),
          ]),
        );
      }
      break;
    }

    case 'message_delta': {
      if (event.usage?.input_tokens !== undefined) {
        state.inputTokens = event.usage.input_tokens;
      }
      if (event.usage?.cache_read_input_tokens !== undefined) {
        state.cacheReadInputTokens = event.usage.cache_read_input_tokens;
      }
      if (event.usage?.cache_creation_input_tokens !== undefined) {
        state.cacheCreationInputTokens = event.usage.cache_creation_input_tokens;
      }
      if (event.usage?.cache_creation !== undefined) {
        state.hasCacheCreationBreakdown = true;
        state.cacheCreation5mInputTokens = event.usage.cache_creation.ephemeral_5m_input_tokens ?? 0;
        state.cacheCreation1hInputTokens = event.usage.cache_creation.ephemeral_1h_input_tokens ?? 0;
      }
      if (event.usage?.speed !== undefined) state.upstreamSpeed = event.usage.speed;
      if (event.usage?.service_tier !== undefined) state.upstreamServiceTier = event.usage.service_tier;
      yield eventFrame(geminiCandidateEvent(flushGeminiThoughtSignature(state), messagesStopReasonToGemini(event.delta.stop_reason), mapUsage(state, event.usage)));
      break;
    }

    case 'message_stop':
    case 'ping':
      break;
    }
  }
};
