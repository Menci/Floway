import type { IRJSONObject } from '../../../ir/types.ts';
import type { ThinState, ThinStateLeaves, ThinValue, TextRule, JSONRule } from '../../../round-trip/thin/assistant-turn.ts';
import type { AnthropicMessagesAssistantContentBlock } from '@floway-dev/protocols/anthropic-messages';

type AnthropicMessagesBlockRule<Block> = Block extends { type: 'text' }
  ? { text: TextRule }
  : Block extends { type: 'thinking' }
    ? { thinking: TextRule }
    : Block extends { type: 'tool_use' }
      ? { input: JSONRule }
      : never;

type AnthropicMessagesThinBlock<Block, Reference> = Block extends unknown
  ? AnthropicMessagesBlockRule<Block> extends never ? Block : ThinValue<Block, AnthropicMessagesBlockRule<Block>, Reference>
  : never;
type AnthropicMessagesBlockState<Block, States extends ThinStateLeaves> = Block extends unknown
  ? AnthropicMessagesBlockRule<Block> extends never ? never : ThinState<Block, AnthropicMessagesBlockRule<Block>, States>
  : never;

export type AnthropicMessagesThinAssistantTurn<Reference> = {
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

export type AnthropicMessagesAssistantState<States extends ThinStateLeaves> = {
  content?: Array<AnthropicMessagesBlockState<AnthropicMessagesAssistantContentBlock, States> | undefined>;
};
