import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import { irInputToolsForChoice } from '../../../ir/input/select-tools.ts';
import type { IRInputRequest, IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiChatCompletionsRequestFromIR } from '../../openai-chat-completions/as-target/input-from.ts';
import { validateAllowedTools } from '../as-source/allowed-tools.ts';
import { partitionOpenAIResponsesTurns } from '../as-source/conversation-turns.ts';
import { openaiResponsesSettingsToIR, openaiResponsesToolsToIR, openaiResponsesDropsReasoning, openaiResponsesTurnToIR } from '../as-source/input-to.ts';
import { flattenNamespaceTools, type NamespaceToolNames } from '../as-source/namespace-tools.ts';
import { rejectProgrammaticOpenAIResponsesPayload } from '../as-source/programmatic-tooling.ts';
import { collectOpenAIResponsesReplayContents, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest } from '../as-source/round-trip.ts';
import { canonicalizeOpenAIResponsesPayload } from '../canonicalize-payload.ts';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';

export interface TargetRequestResult {
  target: OpenAIChatCompletionsPayload;
  namespaceToolNames: NamespaceToolNames;
  /**
   * Names of OpenAI Responses `custom` tools the request translator wrapped as
   * single-string function tools. Returned alongside the translated payload so
   * the trip's events translator can project wrapped function calls back into
   * `custom_tool_call` outputs.
   */
  customToolNames: Set<string>;
}

export const buildTargetRequest = async (source: OpenAIResponsesRequestPayloadEx, codec: SidecarCodec): Promise<TargetRequestResult> => {
  const canonical = canonicalizeOpenAIResponsesPayload(source);
  const { payload, names: namespaceToolNames, flattenInput } = flattenNamespaceTools(canonical);
  // A subset selector names flat callables, so it is checked once namespace and
  // hosted selectors have been rewritten into them: one that still is not flat
  // names something this translation cannot carry.
  validateAllowedTools(payload.tools, payload.tool_choice, payload.input);
  rejectProgrammaticOpenAIResponsesPayload(payload, 'OpenAI Chat Completions');
  const customToolNames = new Set<string>();
  const ir: IRInputRequest = {
    conversation: { turns: [] },
    settings: openaiResponsesSettingsToIR(payload),
    ...openaiResponsesToolsToIR(payload),
  };

  const pieces: (IRInputTurn | IRInputResolvedTurn<OpenAIChatCompletionsMessage>)[] = [];
  if (payload.instructions) {
    pieces.push({ role: 'user', items: [{ type: 'message', role: 'system', content: [{ type: 'text', text: payload.instructions }] }] });
  }
  for (const turn of partitionOpenAIResponsesTurns(canonical.input)) {
    const roundTrip = turn.role === 'assistant' && await roundTripAssistantTurn('openaiResponses', 'openaiChatCompletions', turn.items, codec, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest, collectOpenAIResponsesReplayContents);
    if (roundTrip) {
      pieces.push({ kind: 'resolved', turn: roundTrip.turn });
      continue;
    }
    if (openaiResponsesDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('openaiResponses', 'openaiChatCompletions');
    pieces.push(...openaiResponsesTurnToIR(turn, flattenInput, item => { throw new TranslatorInputError(`Invalid input item type '${(item as { type: string }).type}'.`); }));
  }

  const messages: OpenAIChatCompletionsMessage[] = [];
  let base: OpenAIChatCompletionsPayload | undefined;
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { messages.push(piece.turn); continue; }
    const translated = openaiChatCompletionsRequestFromIR({ ...ir, conversation: { turns: piece.turns } });
    base ??= translated;
    messages.push(...translated.messages);
  }
  base ??= openaiChatCompletionsRequestFromIR({ ...ir, conversation: { turns: [] } });

  // Chat cannot express a freeform tool declaration on every upstream, so this
  // target states it as a function whose single argument is the raw input, and
  // records the names so response events can restore the freeform shape.
  for (const tool of irInputToolsForChoice(ir.tools, ir.tool_choice) ?? []) if (tool.type === 'custom') customToolNames.add(tool.name);
  const target: OpenAIChatCompletionsPayload = { ...base, messages };

  return { target, customToolNames, namespaceToolNames };
};
