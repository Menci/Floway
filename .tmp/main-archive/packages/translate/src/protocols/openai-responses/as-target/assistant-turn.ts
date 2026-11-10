import type { ReferenceState, ReferenceStateLeaves, ReferenceableValue, TextRule } from '../../../round-trip/reference/assistant-turn.ts';
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

type OpenAIResponsesThinItem<T, Reference> = T extends unknown
  ? OpenAIResponsesItemRule<T> extends never ? T : ReferenceableValue<T, OpenAIResponsesItemRule<T>, Reference>
  : never;
export type OpenAIResponsesItemState<T, States extends ReferenceStateLeaves> = T extends unknown
  ? OpenAIResponsesItemRule<T> extends never ? never : ReferenceState<T, OpenAIResponsesItemRule<T>, States>
  : never;

export type OpenAIResponsesReferenceableAssistantTurn<Reference> = OpenAIResponsesThinItem<CanonicalOpenAIResponsesInputItem, Reference>[];
export type OpenAIResponsesOutputAssistantTurn = readonly OpenAIResponsesOutputItemEx[];
export type OpenAIResponsesOutputAssistantState<States extends ReferenceStateLeaves> = Array<OpenAIResponsesItemState<OpenAIResponsesOutputItemEx, States> | undefined>;
export type OpenAIResponsesAssistantState<States extends ReferenceStateLeaves> = Array<OpenAIResponsesItemState<CanonicalOpenAIResponsesInputItem, States> | undefined>;

type OpenAIResponsesOutputMessage = Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>;
type OpenAIResponsesOutputContent = OpenAIResponsesOutputMessage['content'][number];

const stripCreatedBy = (item: OpenAIResponsesOutputItemEx): OpenAIResponsesOutputItemEx => {
  if (!('created_by' in item)) return item;
  const { created_by: _createdBy, ...historyItem } = item;
  return historyItem;
};

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
    const content = historyItem.content.map(part => outputContentToHistoryContent(part));
    return asInputItem(content.every((part, index) => part === historyItem.content[index]) ? historyItem : { ...historyItem, content });
  }
  if (historyItem.type === 'function_call') {
    if (!('parsed_arguments' in historyItem)) return asInputItem(historyItem);
    const { parsed_arguments: _parsedArguments, ...withoutParsedArguments } = historyItem;
    return asInputItem(withoutParsedArguments);
  }
  if (historyItem.type === 'shell_call_output') {
    return asInputItem({ ...historyItem, output: historyItem.output.map(({ created_by: _createdBy, ...output }) => output) });
  }
  if (historyItem.type === 'computer_call_output') return historyItem.status === 'failed' ? null : asInputItem(historyItem);
  if (historyItem.type === 'custom_tool_call_output') {
    if ('status' in historyItem && historyItem.status !== 'completed') return null;
    const { status: _status, ...inputItem } = historyItem;
    return asInputItem(inputItem);
  }
  return asInputItem(historyItem);
};

export function toOpenAIResponsesInputAssistantTurn(
  turn: OpenAIResponsesOutputAssistantTurn,
): CanonicalOpenAIResponsesInputItem[];
export function toOpenAIResponsesInputAssistantTurn<States extends ReferenceStateLeaves>(
  turn: OpenAIResponsesOutputAssistantTurn,
  state: OpenAIResponsesOutputAssistantState<States>,
): { turn: CanonicalOpenAIResponsesInputItem[]; state: OpenAIResponsesAssistantState<States> };
export function toOpenAIResponsesInputAssistantTurn<States extends ReferenceStateLeaves>(
  turn: OpenAIResponsesOutputAssistantTurn,
  state?: OpenAIResponsesOutputAssistantState<States>,
) {
  // Match the official SDK's history normalization for SDK-owned fields and replay-only item transforms.
  // https://github.com/openai/openai-node/blob/f57c9651c8d22ae82cacca27317cfa7126491011/src/lib/responses/ResponseInputItems.ts#L41-L67
  // https://github.com/openai/openai-node/blob/f57c9651c8d22ae82cacca27317cfa7126491011/src/lib/responses/ResponseInputItems.ts#L115-L160
  const items = turn.flatMap((item, index) => {
    const historyItem = outputItemToHistoryItem(item);
    return historyItem === null ? [] : [{ turn: historyItem, sourceIndex: index }];
  });
  const inputTurn = items.map(item => item.turn);
  if (state === undefined) return inputTurn;
  const inputState: OpenAIResponsesAssistantState<States> = [];
  inputState.length = items.length;
  items.forEach(({ turn: inputItem, sourceIndex }, index) => {
    if (!Object.hasOwn(state, sourceIndex)) return;
    const sourceState = state[sourceIndex];
    inputState[index] = sourceState === undefined || inputItem === turn[sourceIndex] ? sourceState : { ...sourceState };
  });
  return { turn: inputTurn, state: inputState };
}
