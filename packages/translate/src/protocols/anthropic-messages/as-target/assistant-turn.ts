import type { IRJSONObject } from '../../../ir/common/json.ts';
import type { ReferenceState, ReferenceStateLeaves, ReferenceableValue, TextRule, JSONRule } from '../../../round-trip/reference/types.ts';
import type { ToolArgumentsEnvelope } from '../../../shared/tool-schema-envelope.ts';
import type { AnthropicMessagesAssistantContentBlock } from '@floway-dev/protocols/anthropic-messages';

type AnthropicMessagesTextBlockRule<Block> = Block extends { type: 'text' }
  ? { text: TextRule }
  : Block extends { type: 'thinking' }
    ? { thinking: TextRule }
    : never;

type AnthropicMessagesReferenceableBlock<Block, Reference> = Block extends { type: 'tool_use' }
  ? {
      [Key in keyof Block]: Key extends 'input'
        ? ReferenceableValue<Block[Key], JSONRule, Reference>
          | ToolArgumentsEnvelope<ReferenceableValue<IRJSONObject, JSONRule, Reference>>
          | { input: ReferenceableValue<string, TextRule, Reference> }
        : Block[Key];
    }
  : AnthropicMessagesTextBlockRule<Block> extends never ? Block : ReferenceableValue<Block, AnthropicMessagesTextBlockRule<Block>, Reference>;
type AnthropicMessagesBlockState<Block, States extends ReferenceStateLeaves> = Block extends { type: 'tool_use' }
  ? { input: States['json'] | ToolArgumentsEnvelope<States['json']> | { input: States['text'] } }
  : AnthropicMessagesTextBlockRule<Block> extends never ? never : ReferenceState<Block, AnthropicMessagesTextBlockRule<Block>, States>;

export type AnthropicMessagesReferenceableInputAssistantTurn<Reference> = {
  role: 'assistant';
  content: AnthropicMessagesReferenceableBlock<AnthropicMessagesAssistantContentBlock, Reference>[];
};
export type AnthropicMessagesInputAssistantTurn = {
  role: 'assistant';
  content: (
    Exclude<AnthropicMessagesAssistantContentBlock, { type: 'tool_use' }>
    | (Extract<AnthropicMessagesAssistantContentBlock, { type: 'tool_use' }> & { input: IRJSONObject })
  )[];
};

export type AnthropicMessagesInputAssistantTurnState<States extends ReferenceStateLeaves> = {
  content?: Array<AnthropicMessagesBlockState<AnthropicMessagesAssistantContentBlock, States> | undefined>;
};
