
import type { IRJSONObject } from '../ir.ts';
import type { IRPath } from '../stream.ts';
import type { IATReference, AnthropicMessagesThinAssistantTurn, IRReplayCandidate } from '../thin-types.ts';
import { createIRRoundTripReplayCheck, verifyIRRoundTripReplayCheck } from './replay-check.ts';
import { replaceIRRoundTripReferences } from './thin-builder.ts';
import type { IRRoundTripAssistantTurnInspection, IRRoundTripConversationTurn, IRRoundTripReplayCheck } from './types.ts';
import type {
  AnthropicMessagesAssistantMessage,
  AnthropicMessagesRedactedThinkingBlock,
  AnthropicMessagesResult,
  AnthropicMessagesMessage,
} from '@floway-dev/protocols/anthropic-messages';

export const ANTHROPIC_MESSAGES_REPLAY_CHECK_VERSION = 1;

export type AnthropicMessagesAssistantHistoryTurn = AnthropicMessagesAssistantMessage[];
export type AnthropicMessagesConversationTurn = IRRoundTripConversationTurn<AnthropicMessagesMessage['role'], AnthropicMessagesMessage>;

const redactedThinkingSidecars = (turn: AnthropicMessagesAssistantHistoryTurn): string[] => turn.flatMap(message => Array.isArray(message.content)
  ? message.content.flatMap(block => block.type === 'redacted_thinking' ? [block.data] : [])
  : []);

const messagesReplayCheckMaterial = (turn: AnthropicMessagesAssistantHistoryTurn): unknown => turn.map(message => ({
  role: message.role,
  ...(Object.hasOwn(message, 'clear_at') ? { clear_at: message.clear_at } : {}),
  ...(Object.hasOwn(message, 'output_config') ? { output_config: message.output_config } : {}),
  content: typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content.filter(block => block.type !== 'redacted_thinking'),
}));

export const partitionAnthropicMessagesTurns = (messages: readonly AnthropicMessagesMessage[]): AnthropicMessagesConversationTurn[] => {
  const turns: AnthropicMessagesConversationTurn[] = [];
  for (const message of messages) {
    const previous = turns.at(-1);
    if (previous?.role === message.role) previous.items.push(message);
    else turns.push({ role: message.role, items: [message] });
  }
  return turns;
};

export const inspectAnthropicMessagesAssistantTurn = (turn: AnthropicMessagesAssistantHistoryTurn): IRRoundTripAssistantTurnInspection => {
  const candidates: IRReplayCandidate[] = [];
  for (const message of turn) {
    if (typeof message.content === 'string') candidates.push(message.content);
    else for (const block of message.content) {
      if (block.type === 'text') {
        candidates.push(block.text);
        for (const citation of block.citations ?? []) candidates.push(citation.cited_text);
      } else if (block.type === 'thinking') candidates.push(block.thinking);
      else if (block.type === 'tool_use') candidates.push(block.input as IRJSONObject);
    }
  }
  return { sidecars: redactedThinkingSidecars(turn), candidates, checkMaterial: messagesReplayCheckMaterial(turn) };
};

export const createAnthropicMessagesReplayCheck = async (turn: AnthropicMessagesAssistantHistoryTurn): Promise<IRRoundTripReplayCheck | undefined> => {
  const inspection = inspectAnthropicMessagesAssistantTurn(turn);
  return inspection.sidecars.length === 1
    ? await createIRRoundTripReplayCheck(inspection.checkMaterial, ANTHROPIC_MESSAGES_REPLAY_CHECK_VERSION)
    : undefined;
};

export const verifyAnthropicMessagesReplayCheck = async (turn: AnthropicMessagesAssistantHistoryTurn, replayCheck: IRRoundTripReplayCheck): Promise<boolean> => {
  const inspection = inspectAnthropicMessagesAssistantTurn(turn);
  return await (inspection.sidecars.length === 1 && verifyIRRoundTripReplayCheck(inspection.checkMaterial, replayCheck, ANTHROPIC_MESSAGES_REPLAY_CHECK_VERSION));
};

export const cleanAnthropicMessagesAssistantTurn = (turn: AnthropicMessagesAssistantHistoryTurn): AnthropicMessagesAssistantHistoryTurn => turn.map(message => ({
  ...message,
  content: typeof message.content === 'string' ? message.content : message.content.filter(block => block.type !== 'redacted_thinking'),
}));

const messagesThinReferencePaths = (turn: AnthropicMessagesResult): IRPath[] => {
  const paths: IRPath[] = [];
  turn.content.forEach((block, blockIndex) => {
    if (block.type === 'text') {
      paths.push(['content', blockIndex, 'text']);
      block.citations?.forEach((citation, citationIndex) => {
        if (typeof citation.cited_text === 'string') paths.push(['content', blockIndex, 'citations', citationIndex, 'cited_text']);
      });
    } else if (block.type === 'thinking') paths.push(['content', blockIndex, 'thinking']);
    else if (block.type === 'tool_use') paths.push(['content', blockIndex, 'input']);
  });
  return paths;
};

export const buildAnthropicMessagesThinAssistantTurn = (
  turn: AnthropicMessagesResult,
  referencesByProtocolPath: ReadonlyMap<string, IATReference>,
): AnthropicMessagesThinAssistantTurn<IATReference> => {
  const content = turn.content.map(block => {
    if (block.type !== 'text' || block.citations === null) return block;
    return {
      ...block,
      citations: block.citations.map(citation => {
        if (citation.type === 'char_location' || citation.type === 'page_location' || citation.type === 'content_block_location') {
          // Message history citation params omit file_id for these locations.
          // https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L1286-L1543
          const { file_id: _fileId, ...inputCitation } = citation;
          return inputCitation;
        }
        return citation;
      }),
    };
  });
  const assistantTurn: AnthropicMessagesAssistantMessage = { role: 'assistant', content: content as AnthropicMessagesAssistantMessage['content'] };
  return replaceIRRoundTripReferences(
    assistantTurn,
    referencesByProtocolPath,
    messagesThinReferencePaths(turn),
  ) as unknown as AnthropicMessagesThinAssistantTurn<IATReference>;
};

// Anthropic uses redacted_thinking for opaque thinking payloads.
// https://platform.claude.com/docs/en/api/messages/create
export const createAnthropicMessagesSidecarCarrier = (data: string): AnthropicMessagesRedactedThinkingBlock => ({ type: 'redacted_thinking', data });
