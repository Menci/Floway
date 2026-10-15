import type { ThinValue, TextRule } from '../../../round-trip/thin/assistant-turn.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesOutputItemEx } from '@floway-dev/protocols/openai-responses';

type OpenAIResponsesItemRule<T> = T extends { type: 'message' }
  ? { content: TextRule | [{ text: TextRule; refusal: TextRule }] }
  : T extends { type: 'reasoning' }
    ? { summary: [{ text: TextRule }]; content: [{ text: TextRule }] }
    : T extends { type: 'function_call' }
      ? { arguments: TextRule }
      : T extends { type: 'custom_tool_call' }
        ? { input: TextRule }
        : never;

export type OpenAIResponsesThinItem<T, Reference> = T extends unknown
  ? OpenAIResponsesItemRule<T> extends never ? T : ThinValue<T, OpenAIResponsesItemRule<T>, Reference>
  : never;

export type OpenAIResponsesThinAssistantTurn<Reference> = OpenAIResponsesThinItem<CanonicalOpenAIResponsesInputItem, Reference>[];

const stripCreatedBy = (item: OpenAIResponsesOutputItemEx): OpenAIResponsesOutputItemEx => {
  if (!('created_by' in item)) return item;
  const { created_by: _createdBy, ...historyItem } = item;
  return historyItem;
};

type OpenAIResponsesOutputMessage = Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>;
type OpenAIResponsesOutputContent = OpenAIResponsesOutputMessage['content'][number];

const outputContentToHistoryContent = (part: OpenAIResponsesOutputContent): OpenAIResponsesOutputContent => {
  if ((part.type !== 'output_text' && part.type !== 'refusal') || !('parsed' in part)) return part;
  const { parsed: _parsed, ...historyContent } = part;
  return historyContent;
};

// OpenAI defines output and replayable input items as separate unions. After the
// SDK's documented output-only fields and variants are removed below, the wire
// object is an input item even though TypeScript cannot encode that union relation.
const asInputItem = (item: OpenAIResponsesOutputItemEx): CanonicalOpenAIResponsesInputItem => item as CanonicalOpenAIResponsesInputItem;

const outputItemToHistoryItem = (item: OpenAIResponsesOutputItemEx): CanonicalOpenAIResponsesInputItem | null => {
  const historyItem = stripCreatedBy(item);
  if (historyItem.type === 'message') {
    const content = historyItem.content.map(outputContentToHistoryContent);
    return asInputItem(content.every((part, index) => part === historyItem.content[index])
      ? historyItem
      : { ...historyItem, content });
  }
  if (historyItem.type === 'function_call') {
    if (!('parsed_arguments' in historyItem)) return asInputItem(historyItem);
    const { parsed_arguments: _parsedArguments, ...withoutParsedArguments } = historyItem;
    return asInputItem(withoutParsedArguments);
  }
  if (historyItem.type === 'additional_tools') return historyItem.role === 'developer' ? asInputItem(historyItem) : null;
  if (historyItem.type === 'shell_call_output') {
    return asInputItem({
      ...historyItem,
      output: historyItem.output.map(({ created_by: _createdBy, ...output }) => output),
    });
  }
  if (historyItem.type === 'computer_call_output') return historyItem.status === 'failed' ? null : asInputItem(historyItem);
  if (historyItem.type === 'custom_tool_call_output') {
    if ('status' in historyItem && historyItem.status !== 'completed') return null;
    const { status: _status, ...inputItem } = historyItem;
    return asInputItem(inputItem);
  }
  return asInputItem(historyItem);
};

export const toOpenAIResponsesInputAssistantTurn = (
  turn: readonly OpenAIResponsesOutputItemEx[],
): CanonicalOpenAIResponsesInputItem[] => turn.flatMap(item => {
  const historyItem = outputItemToHistoryItem(item);
  return historyItem === null ? [] : [historyItem];
});
