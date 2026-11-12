import type { ReferenceState, ReferenceStateLeaves, ReferenceableValue, TextRule } from '../../../round-trip/reference/types.ts';
import { toOpenAIChatCompletionsInputAssistantMessage, type OpenAIChatCompletionsAssistantOutputMessageEx, type OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';

type OpenAIChatCompletionsAssistantRule = {
  content: TextRule | [{ text: TextRule; refusal: TextRule }];
  refusal: TextRule;
  reasoning: TextRule;
  reasoning_text: TextRule;
  reasoning_content: TextRule;
  function_call: { arguments: TextRule };
  tool_calls: [{ function: { arguments: TextRule }; custom: { input: TextRule } }];
};

export type OpenAIChatCompletionsReferenceableInputAssistantTurn<Reference> = ReferenceableValue<OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsAssistantRule, Reference>;
export type OpenAIChatCompletionsOutputAssistantTurn = OpenAIChatCompletionsAssistantOutputMessageEx;
export type OpenAIChatCompletionsInputAssistantTurn = OpenAIChatCompletionsAssistantMessageEx;
export type OpenAIChatCompletionsInputAssistantTurnState<States extends ReferenceStateLeaves> = ReferenceState<OpenAIChatCompletionsInputAssistantTurn, OpenAIChatCompletionsAssistantRule, States>;
export type OpenAIChatCompletionsOutputAssistantTurnState<States extends ReferenceStateLeaves> = ReferenceState<OpenAIChatCompletionsOutputAssistantTurn, OpenAIChatCompletionsAssistantRule, States>;

export const toOpenAIChatCompletionsInputAssistantTurn = <States extends ReferenceStateLeaves>(
  outputTurn: OpenAIChatCompletionsOutputAssistantTurn,
  outputState: OpenAIChatCompletionsOutputAssistantTurnState<States>,
): { turn: OpenAIChatCompletionsInputAssistantTurn; state: OpenAIChatCompletionsInputAssistantTurnState<States> } => ({
  turn: toOpenAIChatCompletionsInputAssistantMessage(outputTurn),
  state: Object.assign({}, outputState),
});
