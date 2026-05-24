import { appendGeminiThoughtSignature, flushGeminiThoughtSignature, type GeminiThoughtSignatureState, geminiResponse, parseStrictJsonObject, signGeminiPart } from '../shared/gemini-via/gemini.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiFinishReason, GeminiStreamEvent, GeminiUsageMetadata } from '@floway-dev/protocols/gemini';
import type { MessagesStreamEventData } from '@floway-dev/protocols/messages';

const messagesStopReasonToGemini = (stopReason: Extract<MessagesStreamEventData, { type: 'message_delta' }>['delta']['stop_reason']): GeminiFinishReason => {
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

const upstreamMessagesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>): AsyncGenerator<MessagesStreamEventData> {
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

interface GeminiViaMessagesStreamState extends GeminiThoughtSignatureState {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  toolUses: Record<number, MessagesToolUseDraft>;
}

// Anthropic's input_tokens excludes cache reads and cache creation; Gemini's
// promptTokenCount is an inclusive total like OpenAI's prompt_tokens. Fold all
// three Anthropic buckets into the Gemini total, then surface cache reads
// separately as cachedContentTokenCount.
const mapUsage = (state: GeminiViaMessagesStreamState, usage?: Extract<MessagesStreamEventData, { type: 'message_delta' }>['usage']): GeminiUsageMetadata | undefined => {
  if (!usage) return undefined;

  const promptTokenCount = state.inputTokens + state.cacheReadInputTokens + state.cacheCreationInputTokens;
  const candidatesTokenCount = usage.output_tokens;

  return {
    promptTokenCount,
    candidatesTokenCount,
    totalTokenCount: promptTokenCount + candidatesTokenCount,
    ...(state.cacheReadInputTokens > 0 ? { cachedContentTokenCount: state.cacheReadInputTokens } : {}),
  };
};

const throwOnMessagesFatalEvent = (event: MessagesStreamEventData): void => {
  if (event.type !== 'error') return;

  throw new Error(`Upstream Messages stream error: ${event.error.type}: ${event.error.message}`, { cause: event });
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const state: GeminiViaMessagesStreamState = {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    toolUses: {},
  };

  for await (const event of upstreamMessagesEventsUntilTerminal(frames)) {
    throwOnMessagesFatalEvent(event);

    switch (event.type) {
    case 'message_start':
      state.inputTokens = event.message.usage.input_tokens;
      state.cacheReadInputTokens = event.message.usage.cache_read_input_tokens ?? 0;
      state.cacheCreationInputTokens = event.message.usage.cache_creation_input_tokens ?? 0;
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
          geminiResponse([
            {
              text: event.content_block.thinking,
              thought: true,
            },
          ]),
        );
        break;
      }

      if (event.content_block.type === 'text' && event.content_block.text.length > 0) {
        yield eventFrame(geminiResponse([signGeminiPart(state, { text: event.content_block.text })]));
      }
      break;

    case 'content_block_delta':
      switch (event.delta.type) {
      case 'thinking_delta':
        if (event.delta.thinking.length > 0) {
          yield eventFrame(geminiResponse([{ text: event.delta.thinking, thought: true }]));
        }
        break;
      case 'signature_delta':
        appendGeminiThoughtSignature(state, event.delta.signature);
        break;
      case 'text_delta':
        if (event.delta.text.length > 0) {
          yield eventFrame(geminiResponse([signGeminiPart(state, { text: event.delta.text })]));
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
          geminiResponse([
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
      yield eventFrame(geminiResponse(flushGeminiThoughtSignature(state), messagesStopReasonToGemini(event.delta.stop_reason), mapUsage(state, event.usage)));
      break;
    }

    case 'message_stop':
    case 'ping':
      break;
    }
  }
};
