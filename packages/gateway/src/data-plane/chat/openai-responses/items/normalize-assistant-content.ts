// Some upstream OpenAI Responses implementations (Copilot's compaction translation,
// and Azure-native compaction) emit assistant messages whose content blocks
// carry `type: 'input_text'` rather than the protocol-correct
// `type: 'output_text'`. The same upstreams then refuse to accept those
// items when echoed back as input on the next turn:
//   `Invalid value: 'input_text'. Supported values are: 'output_text' and
//    'refusal'.`
// We normalize the hydrated payload (i.e. after `item_reference` items have
// been expanded from the snapshot store) so a turn that replays prior
// upstream-produced history — direct client echo, snapshot expansion,
// compaction tail — always crosses the wire with the canonical assistant
// content type. Only `role: 'assistant'` is rewritten; user/system/developer
// messages keep `input_text` because that IS the correct type on those roles.

import type { OpenAIResponsesInputContent, OpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

const normalizeAssistantContentBlocks = (content: string | OpenAIResponsesInputContent[]): string | OpenAIResponsesInputContent[] => {
  if (typeof content === 'string') return content;
  let mutated = false;
  const next = content.map(block => {
    if (block.type !== 'input_text') return block;
    mutated = true;
    return { ...block, type: 'output_text' as const };
  });
  return mutated ? next : content;
};

const normalizeItem = (item: OpenAIResponsesInputItem): OpenAIResponsesInputItem => {
  if (item.type !== 'message' || item.role !== 'assistant') return item;
  const next = normalizeAssistantContentBlocks(item.content);
  return next === item.content ? item : { ...item, content: next };
};

export const normalizeAssistantInputText = (input: OpenAIResponsesInputItem[]): OpenAIResponsesInputItem[] => {
  let mutated = false;
  const next = input.map(item => {
    const replaced = normalizeItem(item);
    if (replaced !== item) mutated = true;
    return replaced;
  });
  return mutated ? next : input;
};
