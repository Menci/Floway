import { TEXT_DECODER, parseProtoFields } from './decoding.ts';
import { parseToolCallStartedUpdate, parsePartialToolCallUpdate } from './tool-calls.ts';
import type { ParsedInteractionUpdate } from './types.ts';

/**
 * Parse an InteractionUpdate message.
 *
 * InteractionUpdate fields:
 *   field 1: text_delta (TextDeltaUpdate)
 *   field 2: tool_call_started (ToolCallStartedUpdate)
 *   field 3: tool_call_completed (ToolCallCompletedUpdate)
 *   field 4: thinking_delta (ThinkingDeltaUpdate) — reasoning/thinking models
 *   field 7: partial_tool_call (PartialToolCallUpdate)
 *   field 8: token_delta (TokenDeltaUpdate)
 *   field 13: heartbeat
 *   field 14: turn_ended (TurnEndedUpdate)
 */
export function parseInteractionUpdate(data: Uint8Array): ParsedInteractionUpdate {
  const fields = parseProtoFields(data);

  let text: string | null = null;
  let thinking: string | null = null;
  let isComplete = false;
  let isHeartbeat = false;
  let tokenDelta: number | null = null;
  let toolCallStarted: ParsedInteractionUpdate['toolCallStarted'] = null;
  let toolCallCompleted: ParsedInteractionUpdate['toolCallCompleted'] = null;
  let partialToolCall: ParsedInteractionUpdate['partialToolCall'] = null;

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const innerFields = parseProtoFields(field.value);
      for (const innerField of innerFields) {
        if (innerField.fieldNumber === 1 && innerField.wireType === 2 && innerField.value instanceof Uint8Array) {
          text = TEXT_DECODER.decode(innerField.value);
        }
      }
    } else if (field.fieldNumber === 2 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const parsed = parseToolCallStartedUpdate(field.value);
      if (parsed.toolCall) {
        toolCallStarted = {
          callId: parsed.callId,
          modelCallId: parsed.modelCallId,
          toolType: parsed.toolCall.toolType,
          name: parsed.toolCall.name,
          arguments: JSON.stringify(parsed.toolCall.arguments),
        };
      }
    } else if (field.fieldNumber === 3 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const parsed = parseToolCallStartedUpdate(field.value);
      if (parsed.toolCall) {
        toolCallCompleted = {
          callId: parsed.callId,
          modelCallId: parsed.modelCallId,
          toolType: parsed.toolCall.toolType,
          name: parsed.toolCall.name,
          arguments: JSON.stringify(parsed.toolCall.arguments),
        };
      }
    } else if (field.fieldNumber === 4 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const innerFields = parseProtoFields(field.value);
      for (const innerField of innerFields) {
        if (innerField.fieldNumber === 1 && innerField.wireType === 2 && innerField.value instanceof Uint8Array) {
          thinking = TEXT_DECODER.decode(innerField.value);
        }
      }
    } else if (field.fieldNumber === 7 && field.wireType === 2 && field.value instanceof Uint8Array) {
      const parsed = parsePartialToolCallUpdate(field.value);
      partialToolCall = {
        callId: parsed.callId,
        argsTextDelta: parsed.argsTextDelta,
      };
    } else if (field.fieldNumber === 8 && field.wireType === 2 && field.value instanceof Uint8Array) {
      // token_delta (TokenDeltaUpdate): a streamed output-token increment.
      // `int32 tokens = 1` is a varint (wireType 0) inside the message — the
      // running sum over a turn is cursor's own output-token count.
      const tokenFields = parseProtoFields(field.value);
      for (const tField of tokenFields) {
        if (tField.fieldNumber === 1 && tField.wireType === 0) {
          tokenDelta = Number(tField.value);
        }
      }
    } else if (field.fieldNumber === 14) {
      isComplete = true;
    } else if (field.fieldNumber === 13) {
      isHeartbeat = true;
    }
  }

  return { text, thinking, isComplete, isHeartbeat, tokenDelta, toolCallStarted, toolCallCompleted, partialToolCall };
}

/**
 * Parse the token details out of a conversation_checkpoint_update
 * (AgentServerMessage field 3 → ConversationStateStructure). Cursor pushes
 * these periodically; they carry the live context accounting the IDE shows.
 *
 * ConversationStateStructure field 5: token_details (ConversationTokenDetails)
 * ConversationTokenDetails field 1: used_tokens (uint32), field 2: max_tokens.
 *
 * Returns null when the checkpoint carries no token_details.
 */
export function parseCheckpointTokenDetails(data: Uint8Array): { usedTokens: number; maxTokens: number } | null {
  for (const field of parseProtoFields(data)) {
    if (field.fieldNumber === 5 && field.wireType === 2 && field.value instanceof Uint8Array) {
      let usedTokens = 0;
      let maxTokens = 0;
      for (const tf of parseProtoFields(field.value)) {
        if (tf.fieldNumber === 1 && tf.wireType === 0) usedTokens = Number(tf.value);
        else if (tf.fieldNumber === 2 && tf.wireType === 0) maxTokens = Number(tf.value);
      }
      return { usedTokens, maxTokens };
    }
  }
  return null;
}
