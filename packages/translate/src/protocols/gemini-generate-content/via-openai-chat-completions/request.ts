import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiChatCompletionsSettingsFromIR, openaiChatCompletionsFromIR } from '../../openai-chat-completions/as-target/input-from.ts';
import { geminiGenerateContentText } from '../as-source/content.ts';
import { partitionGeminiGenerateContentTurns } from '../as-source/conversation-turns.ts';
import { geminiGenerateContentDropsReasoning, geminiGenerateContentSettingsToIR, geminiGenerateContentTurnToIR } from '../as-source/input-to.ts';
import { geminiGenerateContentReasoningEffort } from '../as-source/reasoning.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from '../as-source/round-trip.ts';
import { geminiFunctionParameters } from '../as-source/schema.ts';
import { geminiGenerateContentFunctionCallingIntent, geminiGenerateContentFunctionDeclarations, type GeminiGenerateContentToolCallIds } from '../as-source/tools.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage, OpenAIChatCompletionsTool } from '@floway-dev/protocols/openai-chat-completions';

const applyGenerationConfig = (request: OpenAIChatCompletionsPayload, payload: GeminiGenerateContentPayload, model: string): void => {
  const source = geminiGenerateContentSettingsToIR(payload, model);
  Object.assign(request, openaiChatCompletionsSettingsFromIR({
    ...source,
    // Chat requires a name for a json_schema format; this is the established
    // spelling for a GenerateContent source.
    ...(source.output_format === undefined ? {} : { output_format: { ...source.output_format, name: 'gemini_response' } }),
  }));

  const config = payload.generationConfig;
  if (config?.candidateCount !== undefined) request.n = config.candidateCount;
  if (config?.presencePenalty !== undefined) request.presence_penalty = config.presencePenalty;
  if (config?.frequencyPenalty !== undefined) request.frequency_penalty = config.frequencyPenalty;
  const reasoningEffort = config === undefined ? null : geminiGenerateContentReasoningEffort(config.thinkingConfig);
  if (reasoningEffort !== null) request.reasoning_effort = reasoningEffort;
};

const buildTools = (payload: GeminiGenerateContentPayload): OpenAIChatCompletionsTool[] | undefined => {
  const tools = geminiGenerateContentFunctionDeclarations(payload, 'any').map(declaration => {
    const parameters = geminiFunctionParameters(declaration);
    return {
      type: 'function' as const,
      function: {
        name: declaration.name,
        ...(declaration.description !== undefined ? { description: declaration.description } : {}),
        ...(parameters !== undefined ? { parameters } : {}),
      },
    };
  });

  return tools.length ? tools : undefined;
};

export const buildTargetRequest = async (
  payload: GeminiGenerateContentPayload,
  model: string,
  codec: SidecarCodec,
): Promise<OpenAIChatCompletionsPayload> => {
  const request: OpenAIChatCompletionsPayload = {
    model,
    stream: true,
    messages: [],
  };
  const unmatchedToolCallIds: GeminiGenerateContentToolCallIds = Object.create(null);

  const systemText = geminiGenerateContentText(payload.systemInstruction);
  if (systemText !== null) {
    request.messages.push({ role: 'system', content: systemText });
  }

  let contentIndex = 0;
  const pieces: (IRInputTurn | IRInputResolvedTurn<OpenAIChatCompletionsMessage>)[] = [];
  for (const turn of partitionGeminiGenerateContentTurns(payload.contents ?? [])) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('geminiGenerateContent', 'openaiChatCompletions', turn.items, codec, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest, collectGeminiGenerateContentReplayContents);
      if (roundTrip !== undefined) {
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        if (roundTrip.turn.function_call == null) {
          for (const call of roundTrip.turn.tool_calls ?? []) {
            const name = call.type === 'function' ? call.function.name : call.custom.name;
            unmatchedToolCallIds[name] ??= [];
            unmatchedToolCallIds[name].push(call.id);
          }
        }
        contentIndex += turn.items.length;
        continue;
      }
    }
    if (geminiGenerateContentDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('geminiGenerateContent', 'openaiChatCompletions');
    pieces.push(geminiGenerateContentTurnToIR(turn, contentIndex, unmatchedToolCallIds));
    contentIndex += turn.items.length;
  }

  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { request.messages.push(piece.turn); continue; }
    request.messages.push(...openaiChatCompletionsFromIR({ turns: piece.turns }));
  }

  applyGenerationConfig(request, payload, model);

  const tools = buildTools(payload);
  if (tools) {
    request.tools = tools;

    const intent = geminiGenerateContentFunctionCallingIntent(payload.toolConfig?.functionCallingConfig);
    switch (intent?.type) {
    case 'none':
      request.tool_choice = 'none';
      break;
    case 'auto':
      request.tool_choice = 'auto';
      break;
    case 'any':
      request.tool_choice = 'required';
      break;
    case 'named':
      request.tool_choice = {
        type: 'function',
        function: { name: intent.name },
      };
      break;
    }
  }

  return request;
};
