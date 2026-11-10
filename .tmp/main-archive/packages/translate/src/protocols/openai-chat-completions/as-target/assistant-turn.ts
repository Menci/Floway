import type { ReferenceState, ReferenceStateLeaves, ReferenceableValue, TextRule } from '../../../round-trip/reference/assistant-turn.ts';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsAssistantOutputMessageEx } from '@floway-dev/protocols/openai-chat-completions';

type OpenAIChatCompletionsAssistantRule = {
  content: TextRule | [{ text: TextRule; refusal: TextRule }];
  refusal: TextRule;
  reasoning: TextRule;
  reasoning_text: TextRule;
  reasoning_content: TextRule;
  function_call: { arguments: TextRule };
  tool_calls: [{ function: { arguments: TextRule }; custom: { input: TextRule } }];
};

export type OpenAIChatCompletionsReferenceableAssistantTurn<Reference> = ReferenceableValue<OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsAssistantRule, Reference>;
export type OpenAIChatCompletionsOutputAssistantTurn = OpenAIChatCompletionsAssistantOutputMessageEx;
export type OpenAIChatCompletionsInputAssistantTurn = OpenAIChatCompletionsAssistantMessageEx;
export type OpenAIChatCompletionsAssistantState<States extends ReferenceStateLeaves> = ReferenceState<OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsAssistantRule, States>;
export type OpenAIChatCompletionsOutputAssistantState<States extends ReferenceStateLeaves> = OpenAIChatCompletionsAssistantState<States>
  & ReferenceState<OpenAIChatCompletionsAssistantOutputMessageEx, OpenAIChatCompletionsAssistantRule, States>;

export function toOpenAIChatCompletionsInputAssistantTurn(
  outputTurn: OpenAIChatCompletionsOutputAssistantTurn,
): OpenAIChatCompletionsInputAssistantTurn;
export function toOpenAIChatCompletionsInputAssistantTurn<States extends ReferenceStateLeaves>(
  outputTurn: OpenAIChatCompletionsOutputAssistantTurn,
  outputState: OpenAIChatCompletionsOutputAssistantState<States>,
): { turn: OpenAIChatCompletionsInputAssistantTurn; state: OpenAIChatCompletionsAssistantState<States> };
export function toOpenAIChatCompletionsInputAssistantTurn<States extends ReferenceStateLeaves>(
  outputTurn: OpenAIChatCompletionsOutputAssistantTurn,
  outputState?: OpenAIChatCompletionsOutputAssistantState<States>,
): OpenAIChatCompletionsInputAssistantTurn | {
  turn: OpenAIChatCompletionsInputAssistantTurn;
  state: OpenAIChatCompletionsAssistantState<States>;
} {
  // The SDK serializes supplied message fields directly; prior audio input uses an ID reference.
  // https://github.com/openai/openai-node/blob/f57c9651c8d22ae82cacca27317cfa7126491011/src/resources/chat/completions/completions.ts#L195-L210
  // https://github.com/openai/openai-node/blob/f57c9651c8d22ae82cacca27317cfa7126491011/src/client.ts#L637-L637
  // https://github.com/openai/openai-node/blob/f57c9651c8d22ae82cacca27317cfa7126491011/src/internal/request-options.ts#L115-L144
  // The response object also carries audio bytes, expiry, and transcript.
  // https://github.com/openai/openai-node/blob/f57c9651c8d22ae82cacca27317cfa7126491011/src/resources/chat/completions/completions.ts#L884-L935
  // https://github.com/openai/openai-node/blob/f57c9651c8d22ae82cacca27317cfa7126491011/src/resources/chat/completions/completions.ts#L962-L984
  const { audio, ...message } = outputTurn;
  const turn = {
    ...message,
    ...(Object.hasOwn(outputTurn, 'audio') ? { audio: audio === null || audio === undefined ? audio : { id: audio.id } } : {}),
  };
  if (outputState === undefined) return turn;
  return { turn, state: Object.assign({}, outputState) };
}
