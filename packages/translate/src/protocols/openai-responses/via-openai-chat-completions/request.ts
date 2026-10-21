import { klona } from 'klona/json';

import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiChatCompletionsEnvelopeFromIR, openaiChatCompletionsFromIR } from '../../openai-chat-completions/as-target/input-from.ts';
import { restrictAllowedTools } from '../as-source/allowed-tools.ts';
import { partitionOpenAIResponsesTurns } from '../as-source/conversation-turns.ts';
import { openaiResponsesEnvelopeToIR, openaiResponsesDropsReasoning, openaiResponsesTurnToIR } from '../as-source/input-to.ts';
import { flattenNamespaceTools, type NamespaceToolNames } from '../as-source/namespace-tools.ts';
import { rejectProgrammaticOpenAIResponsesPayload } from '../as-source/programmatic-tooling.ts';
import { collectOpenAIResponsesReplayContents, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest } from '../as-source/round-trip.ts';
import { canonicalizeOpenAIResponsesPayload } from '../canonicalize-payload.ts';
import { buildCustomToolInputSchema } from '../common/custom-tool-wrap.ts';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage, OpenAIChatCompletionsTool } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';

const translateOpenAIResponsesTools = (tools: OpenAIResponsesTool[] | null | undefined, customToolNames: Set<string>): OpenAIChatCompletionsTool[] | undefined => {
  // After allowed_tools selection, Chat Completions can represent only flat
  // function and custom declarations. Custom tools are wrapped as functions
  // and recorded so response events can restore their freeform shape. The
  // server-tool shim rewrites hosted web_search declarations to ordinary
  // function tools before this translation, so retained shim tools need no
  // special handling here.
  const out: OpenAIChatCompletionsTool[] = [];

  for (const tool of tools ?? []) {
    if (tool.type === 'function') {
      out.push({
        type: 'function',
        function: {
          name: tool.name,
          // OpenAI Responses spells "unspecified" as an omitted key or an explicit
          // `null`; OpenAI Chat Completions has only the omitted-key spelling.
          ...(tool.parameters == null ? {} : { parameters: klona(tool.parameters) }),
          ...(tool.strict == null ? {} : { strict: tool.strict }),
          ...(tool.description ? { description: tool.description } : {}),
        },
      });
      continue;
    }
    if (tool.type === 'custom') {
      customToolNames.add(tool.name);
      out.push({
        type: 'function',
        function: {
          name: tool.name,
          parameters: buildCustomToolInputSchema(tool.format),
          strict: false,
          ...(tool.description ? { description: tool.description } : {}),
        },
      });
      continue;
    }
    throw new TranslatorInputError(`Cannot translate OpenAI Responses tool type '${tool.type}' to OpenAI Chat Completions.`);
  }

  return out.length > 0 ? out : undefined;
};

const translateOpenAIResponsesToolChoice = (choice?: OpenAIResponsesToolChoice | null): OpenAIChatCompletionsPayload['tool_choice'] => {
  if (choice == null) return undefined;
  if (typeof choice === 'string') {
    if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
    throw new TranslatorInputError(`Cannot translate OpenAI Responses tool choice '${choice}' to OpenAI Chat Completions.`);
  }
  // Both function and wrapped custom tools land on the target as named function
  // choices since they share the function-tool wire shape after translation.
  if (choice.type !== 'function' && choice.type !== 'custom') throw new TranslatorInputError(`Cannot translate OpenAI Responses tool choice type '${choice.type}' to OpenAI Chat Completions.`);
  return { type: 'function', function: { name: choice.name } };
};

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
  rejectProgrammaticOpenAIResponsesPayload(payload, 'OpenAI Chat Completions');
  const customToolNames = new Set<string>();
  const legacyFunctionNames = new Map<string, string>();
  const envelope = openaiChatCompletionsEnvelopeFromIR(openaiResponsesEnvelopeToIR(payload));

  const allowed = restrictAllowedTools(payload.tools, payload.tool_choice);
  const tools = translateOpenAIResponsesTools(allowed.tools, customToolNames);
  // Same-purpose OpenAI fields pass through directly here, while broader
  // OpenAI-Responses-only state such as `previous_response_id` remains native-only.
  const target: OpenAIChatCompletionsPayload = {
    ...envelope,
    model: payload.model,
    messages: [],
    stream: true,
    ...(payload.metadata !== undefined ? { metadata: klona(payload.metadata) } : {}),
    ...(payload.store !== undefined ? { store: payload.store } : {}),
    ...(payload.parallel_tool_calls != null ? { parallel_tool_calls: payload.parallel_tool_calls } : {}),
    ...(payload.prompt_cache_key !== undefined ? { prompt_cache_key: payload.prompt_cache_key } : {}),
    ...(payload.safety_identifier !== undefined ? { safety_identifier: payload.safety_identifier } : {}),
    ...(payload.reasoning?.effort != null ? { reasoning_effort: payload.reasoning.effort } : {}),
    ...(payload.text?.verbosity != null ? { verbosity: payload.text.verbosity } : {}),
    ...(payload.service_tier !== undefined ? { service_tier: payload.service_tier } : {}),
    tools,
    tool_choice: translateOpenAIResponsesToolChoice(allowed.choice),
  };

  const pieces: (IRInputTurn | IRInputResolvedTurn<OpenAIChatCompletionsMessage>)[] = [];
  // `instructions` is the Responses spelling of a leading system prompt, so it
  // joins the conversation as one.
  if (payload.instructions) {
    pieces.push({ role: 'user', items: [{ type: 'message', role: 'system', content: [{ type: 'text', text: payload.instructions }] }] });
  }
  for (const turn of partitionOpenAIResponsesTurns(canonical.input)) {
    const roundTrip = turn.role === 'assistant' && await roundTripAssistantTurn('openaiResponses', 'openaiChatCompletions', turn.items, codec, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest, collectOpenAIResponsesReplayContents);
    if (roundTrip) {
      if (roundTrip.turn.function_call != null) {
        const modernIds = new Set(roundTrip.turn.tool_calls?.map(call => call.id));
        for (const item of turn.items) {
          if ((item.type === 'function_call' || item.type === 'custom_tool_call') && !modernIds.has(item.call_id)) legacyFunctionNames.set(item.call_id, roundTrip.turn.function_call.name);
        }
      }
      pieces.push({ kind: 'resolved', turn: roundTrip.turn });
      continue;
    }
    if (openaiResponsesDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('openaiResponses', 'openaiChatCompletions');
    pieces.push(...openaiResponsesTurnToIR(turn, flattenInput, item => { throw new TranslatorInputError(`Invalid input item type '${(item as { type: string }).type}'.`); }));
  }

  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') {
      target.messages.push(piece.turn);
      continue;
    }
    target.messages.push(...openaiChatCompletionsFromIR({ turns: piece.turns }, { legacyFunctionNames }));
  }

  return { target, customToolNames, namespaceToolNames };
};
