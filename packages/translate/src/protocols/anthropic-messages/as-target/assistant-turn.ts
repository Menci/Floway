import type { IRJSONObject } from '../../../ir/types.ts';
import type { ReferenceState, ReferenceStateLeaves, ReferenceableValue, TextRule, JSONRule } from '../../../round-trip/reference/assistant-turn.ts';
import type { AnthropicMessagesAssistantContentBlock } from '@floway-dev/protocols/anthropic-messages';

type AnthropicMessagesBlockRule<Block> = Block extends { type: 'text' }
  ? { text: TextRule }
  : Block extends { type: 'thinking' }
    ? { thinking: TextRule }
    : Block extends { type: 'tool_use' }
      ? { input: JSONRule }
      : never;

type AnthropicMessagesThinBlock<Block, Reference> = Block extends unknown
  ? AnthropicMessagesBlockRule<Block> extends never ? Block : ReferenceableValue<Block, AnthropicMessagesBlockRule<Block>, Reference>
  : never;
type AnthropicMessagesBlockState<Block, States extends ReferenceStateLeaves> = Block extends unknown
  ? AnthropicMessagesBlockRule<Block> extends never ? never : ReferenceState<Block, AnthropicMessagesBlockRule<Block>, States>
  : never;

export type AnthropicMessagesReferenceableAssistantTurn<Reference> = {
  role: 'assistant';
  content: AnthropicMessagesThinBlock<AnthropicMessagesAssistantContentBlock, Reference>[];
};
export type AnthropicMessagesInputAssistantTurn = {
  role: 'assistant';
  content: (
    Exclude<AnthropicMessagesAssistantContentBlock, { type: 'tool_use' }>
    | (Extract<AnthropicMessagesAssistantContentBlock, { type: 'tool_use' }> & { input: IRJSONObject })
  )[];
};

export type AnthropicMessagesAssistantState<States extends ReferenceStateLeaves> = {
  content?: Array<AnthropicMessagesBlockState<AnthropicMessagesAssistantContentBlock, States> | undefined>;
};
