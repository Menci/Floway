import { flushGeminiGenerateContentThoughtSignature, type GeminiGenerateContentThoughtSignatureState, geminiGenerateContentCandidateEvent, parseStrictJsonObject, setGeminiGenerateContentThoughtSignature, signGeminiGenerateContentPart } from '../shared/gemini-generate-content-via/gemini-generate-content.ts';
import { anthropicMessagesRefusalExplanation } from '../shared/via-anthropic-messages/refusal.ts';
import { inclusiveAnthropicMessagesInputUsage } from '../shared/via-anthropic-messages/usage.ts';
import { billableServiceTier, eventFrame, splitInclusiveInputTokens, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentFinishReason, GeminiGenerateContentStreamEvent, GeminiGenerateContentUsageMetadata } from '@floway-dev/protocols/gemini-generate-content';
import { mergeAnthropicMessagesUsageSnapshot, anthropicMessagesUsageSnapshot, type AnthropicMessagesStreamEvent, type AnthropicMessagesUsageSnapshot } from '@floway-dev/protocols/anthropic-messages';

const anthropicMessagesStopReasonToGeminiGenerateContent = (stopReason: Extract<AnthropicMessagesStreamEvent, { type: 'message_delta' }>['delta']['stop_reason']): GeminiGenerateContentFinishReason => {
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

const UPSTREAM_ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE = 'Upstream Anthropic Messages stream ended without a message_stop event.';

const upstreamAnthropicMessagesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>): AsyncGenerator<AnthropicMessagesStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (frame.event.type === 'message_stop' || frame.event.type === 'error') {
      return;
    }
  }

  throw new Error(UPSTREAM_ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE);
};

interface AnthropicMessagesToolUseDraft {
  id?: string;
  name?: string;
  argsJson: string;
  args?: Record<string, unknown>;
}

interface AnthropicMessagesToGeminiGenerateContentStreamState extends GeminiGenerateContentThoughtSignatureState {
  usage: AnthropicMessagesUsageSnapshot;
  toolUses: Record<number, AnthropicMessagesToolUseDraft>;
}

// Gemini's `promptTokenCount` is an inclusive total that already contains the
// cached prefix, and `cachedContentTokenCount` is the breakdown of that share
// rather than an extra bucket — so the folded Anthropic total goes out whole
// and cache reads are re-surfaced alongside it, not subtracted from it.
// https://github.com/googleapis/js-genai/blob/86d4bfa5b8d026b6d9fae46f0069e7b7972beb80/src/types.ts#L7594-L7597
const mapUsage = (state: AnthropicMessagesToGeminiGenerateContentStreamState, hasTerminalUsage: boolean): GeminiGenerateContentUsageMetadata | undefined => {
  const { cacheRead, cacheWrite, cacheWrite1h, inclusiveInput: promptTokenCount } = inclusiveAnthropicMessagesInputUsage(state.usage);
  const cacheWriteTotal = cacheWrite + cacheWrite1h;
  const candidatesTokenCount = state.usage.output_tokens;
  splitInclusiveInputTokens(promptTokenCount, cacheRead, cacheWriteTotal);
  const serviceTier = billableServiceTier(state.usage.speed) ?? billableServiceTier(state.usage.service_tier);
  if (!hasTerminalUsage && promptTokenCount === 0 && serviceTier === null) return undefined;

  return {
    promptTokenCount,
    candidatesTokenCount,
    totalTokenCount: promptTokenCount + candidatesTokenCount,
    ...(cacheRead > 0 ? { cachedContentTokenCount: cacheRead } : {}),
  };
};

const throwOnAnthropicMessagesFatalEvent = (event: AnthropicMessagesStreamEvent): void => {
  if (event.type !== 'error') return;

  throw new Error(`Upstream Anthropic Messages stream error: ${event.error.type}: ${event.error.message}`, { cause: event });
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
  const state: AnthropicMessagesToGeminiGenerateContentStreamState = {
    usage: anthropicMessagesUsageSnapshot(),
    toolUses: {},
  };

  for await (const event of upstreamAnthropicMessagesEventsUntilTerminal(frames)) {
    throwOnAnthropicMessagesFatalEvent(event);

    switch (event.type) {
    case 'message_start':
      state.usage = anthropicMessagesUsageSnapshot(event.message.usage);
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
        setGeminiGenerateContentThoughtSignature(state, event.content_block.data);
        break;
      }

      if (event.content_block.type === 'thinking' && event.content_block.thinking.length > 0) {
        yield eventFrame(
          geminiGenerateContentCandidateEvent([
            {
              text: event.content_block.thinking,
              thought: true,
            },
          ]),
        );
        break;
      }

      if (event.content_block.type === 'text' && event.content_block.text.length > 0) {
        yield eventFrame(geminiGenerateContentCandidateEvent([signGeminiGenerateContentPart(state, { text: event.content_block.text })]));
      }
      break;

    case 'content_block_delta':
      switch (event.delta.type) {
      case 'thinking_delta':
        if (event.delta.thinking.length > 0) {
          yield eventFrame(geminiGenerateContentCandidateEvent([{ text: event.delta.thinking, thought: true }]));
        }
        break;
      case 'signature_delta':
        setGeminiGenerateContentThoughtSignature(state, event.delta.signature);
        break;
      case 'text_delta':
        if (event.delta.text.length > 0) {
          yield eventFrame(geminiGenerateContentCandidateEvent([signGeminiGenerateContentPart(state, { text: event.delta.text })]));
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
          throw new Error('Anthropic Messages tool use ended without a name.');
        }

        yield eventFrame(
          geminiGenerateContentCandidateEvent([
            signGeminiGenerateContentPart(state, {
              functionCall: {
                ...(toolUse.id !== undefined ? { id: toolUse.id } : {}),
                name: toolUse.name,
                args: toolUse.argsJson ? parseStrictJsonObject(toolUse.argsJson, 'Anthropic Messages tool use input') : toolUse.args ?? {},
              },
            }),
          ]),
        );
      }
      break;
    }

    case 'message_delta': {
      if (event.usage) state.usage = mergeAnthropicMessagesUsageSnapshot(state.usage, event.usage);
      yield eventFrame(geminiGenerateContentCandidateEvent(
        flushGeminiGenerateContentThoughtSignature(state),
        anthropicMessagesStopReasonToGeminiGenerateContent(event.delta.stop_reason),
        mapUsage(state, event.usage !== undefined),
        event.delta.stop_reason === 'refusal' ? anthropicMessagesRefusalExplanation(event.delta.stop_details) : undefined,
      ));
      break;
    }

    case 'message_stop':
    case 'ping':
      break;
    }
  }
};
