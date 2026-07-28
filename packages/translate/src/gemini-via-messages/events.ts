import { flushGeminiThoughtSignature, type GeminiThoughtSignatureState, geminiCandidateEvent, parseStrictJsonObject, setGeminiThoughtSignature, signGeminiPart } from '../shared/gemini-via/gemini.ts';
import { messagesRefusalExplanation } from '../shared/via-messages/refusal.ts';
import { inclusiveMessagesInputUsage } from '../shared/via-messages/usage.ts';
import { billableServiceTier, eventFrame, splitInclusiveInputTokens, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiFinishReason, GeminiStreamEvent, GeminiUsageMetadata } from '@floway-dev/protocols/gemini';
import { mergeMessagesUsageSnapshot, messagesUsageSnapshot, type MessagesStreamEvent, type MessagesUsageSnapshot } from '@floway-dev/protocols/messages';

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
  usage: MessagesUsageSnapshot;
  toolUses: Record<number, MessagesToolUseDraft>;
}

// Gemini's `promptTokenCount` is an inclusive total that already contains the
// cached prefix, and `cachedContentTokenCount` is the breakdown of that share
// rather than an extra bucket — so the folded Anthropic total goes out whole
// and cache reads are re-surfaced alongside it, not subtracted from it.
// https://github.com/googleapis/js-genai/blob/86d4bfa5b8d026b6d9fae46f0069e7b7972beb80/src/types.ts#L7594-L7597
const mapUsage = (state: MessagesToGeminiStreamState, hasTerminalUsage: boolean): GeminiUsageMetadata | undefined => {
  const { cacheRead, cacheWrite, cacheWrite1h, inclusiveInput: promptTokenCount } = inclusiveMessagesInputUsage(state.usage);
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

const throwOnMessagesFatalEvent = (event: MessagesStreamEvent): void => {
  if (event.type !== 'error') return;

  throw new Error(`Upstream Messages stream error: ${event.error.type}: ${event.error.message}`, { cause: event });
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const state: MessagesToGeminiStreamState = {
    usage: messagesUsageSnapshot(),
    toolUses: {},
  };

  for await (const event of upstreamMessagesEventsUntilTerminal(frames)) {
    throwOnMessagesFatalEvent(event);

    switch (event.type) {
    case 'message_start':
      state.usage = messagesUsageSnapshot(event.message.usage);
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
        setGeminiThoughtSignature(state, event.content_block.data);
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
        setGeminiThoughtSignature(state, event.delta.signature);
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
      if (event.usage) state.usage = mergeMessagesUsageSnapshot(state.usage, event.usage);
      yield eventFrame(geminiCandidateEvent(
        flushGeminiThoughtSignature(state),
        messagesStopReasonToGemini(event.delta.stop_reason),
        mapUsage(state, event.usage !== undefined),
        event.delta.stop_reason === 'refusal' ? messagesRefusalExplanation(event.delta.stop_details) : undefined,
      ));
      break;
    }

    case 'message_stop':
    case 'ping':
      break;
    }
  }
};
