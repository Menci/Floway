import type { ReferenceState, ReferenceStateLeaves, ReferenceableValue, TextRule } from '../../../round-trip/reference/types.ts';
import { toOpenAIResponsesInputItem, type OpenAIResponsesOutputItemEx, type CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

type OpenAIResponsesItemRule<T> = T extends { type: 'message' }
  ? { content: TextRule | [{ text: TextRule; refusal: TextRule }] }
  : T extends { type: 'reasoning' }
    ? { summary: [{ text: TextRule }]; content: [{ text: TextRule }] }
    : T extends { type: 'function_call' }
      ? { arguments: TextRule }
      : T extends { type: 'custom_tool_call' }
        ? { input: TextRule }
        : never;

type OpenAIResponsesReferenceableItem<T, Reference> = T extends unknown
  ? OpenAIResponsesItemRule<T> extends never ? T : ReferenceableValue<T, OpenAIResponsesItemRule<T>, Reference>
  : never;
export type OpenAIResponsesItemState<T, States extends ReferenceStateLeaves> = T extends unknown
  ? OpenAIResponsesItemRule<T> extends never ? never : ReferenceState<T, OpenAIResponsesItemRule<T>, States>
  : never;

export type OpenAIResponsesInputAssistantTurn = CanonicalOpenAIResponsesInputItem[];
export type OpenAIResponsesReferenceableInputAssistantTurn<Reference> = OpenAIResponsesReferenceableItem<CanonicalOpenAIResponsesInputItem, Reference>[];
export type OpenAIResponsesOutputAssistantTurn = readonly OpenAIResponsesOutputItemEx[];
export type OpenAIResponsesOutputAssistantTurnState<States extends ReferenceStateLeaves> = Array<OpenAIResponsesItemState<OpenAIResponsesOutputItemEx, States> | undefined>;
export type OpenAIResponsesInputAssistantTurnState<States extends ReferenceStateLeaves> = Array<OpenAIResponsesItemState<CanonicalOpenAIResponsesInputItem, States> | undefined>;

export const toOpenAIResponsesInputAssistantTurn = <States extends ReferenceStateLeaves>(
  turn: OpenAIResponsesOutputAssistantTurn,
  state: OpenAIResponsesOutputAssistantTurnState<States>,
): { turn: OpenAIResponsesInputAssistantTurn; state: OpenAIResponsesInputAssistantTurnState<States> } => {
  const items = turn.flatMap((item, index) => {
    const historyItem = toOpenAIResponsesInputItem(item);
    return historyItem === null ? [] : [{ turn: historyItem, sourceIndex: index }];
  });
  const inputTurn = items.map(item => item.turn);
  const inputState: OpenAIResponsesInputAssistantTurnState<States> = [];
  inputState.length = items.length;
  items.forEach(({ turn: inputItem, sourceIndex }, index) => {
    if (!Object.hasOwn(state, sourceIndex)) return;
    const sourceState = state[sourceIndex];
    inputState[index] = sourceState === undefined || inputItem === turn[sourceIndex] ? sourceState : { ...sourceState };
  });
  return { turn: inputTurn, state: inputState };
};
