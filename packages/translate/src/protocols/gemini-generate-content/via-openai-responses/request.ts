import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiResponsesEnvelopeFromIR, openaiResponsesFromIR } from '../../openai-responses/as-target/input-from.ts';
import { geminiGenerateContentText } from '../as-source/content.ts';
import { partitionGeminiGenerateContentTurns } from '../as-source/conversation-turns.ts';
import { geminiGenerateContentDropsReasoning, geminiGenerateContentEnvelopeToIR, geminiGenerateContentTurnToIR } from '../as-source/input-to.ts';
import { geminiGenerateContentReasoningEffort } from '../as-source/reasoning.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from '../as-source/round-trip.ts';
import { geminiFunctionParameters } from '../as-source/schema.ts';
import { geminiGenerateContentFunctionCallingIntent, geminiGenerateContentFunctionDeclarations, type GeminiGenerateContentToolCallIds } from '../as-source/tools.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { CanonicalOpenAIResponsesPayload, CanonicalOpenAIResponsesInputItem, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';

const applyGenerationConfig = (request: CanonicalOpenAIResponsesPayload, payload: GeminiGenerateContentPayload, model: string): void => {
  const source = geminiGenerateContentEnvelopeToIR(payload, model);
  Object.assign(request, openaiResponsesEnvelopeFromIR({
    ...source,
    // Responses requires a name for a json_schema format; this is the
    // established spelling for a GenerateContent source.
    ...(source.output_format === undefined ? {} : { output_format: { ...source.output_format, name: 'gemini_response' } }),
  }));

  const config = payload.generationConfig;
  const effort = config === undefined ? null : geminiGenerateContentReasoningEffort(config.thinkingConfig);
  if (effort === null) return;
  request.reasoning = {
    effort,
    ...(effort !== 'none' && config?.thinkingConfig?.includeThoughts === true ? { summary: 'detailed' as const } : {}),
  };
};

const buildTools = (payload: GeminiGenerateContentPayload): OpenAIResponsesTool[] | undefined => {
  const tools = geminiGenerateContentFunctionDeclarations(payload, 'any').map(declaration => ({
    type: 'function' as const,
    name: declaration.name,
    ...(declaration.description !== undefined ? { description: declaration.description } : {}),
    parameters: geminiFunctionParameters(declaration) ?? { type: 'object', properties: {} },
    strict: false,
  }));

  return tools.length ? tools : undefined;
};

export const buildTargetRequest = async (
  payload: GeminiGenerateContentPayload,
  model: string,
  codec: SidecarCodec,
): Promise<CanonicalOpenAIResponsesPayload> => {
  const input: CanonicalOpenAIResponsesInputItem[] = [];
  const request: CanonicalOpenAIResponsesPayload = {
    model,
    stream: true,
    input,
  };
  const unmatchedToolCallIds: GeminiGenerateContentToolCallIds = Object.create(null);

  const instructions = geminiGenerateContentText(payload.systemInstruction);
  if (instructions !== null) request.instructions = instructions;

  let contentIndex = 0;
  const pieces: (IRInputTurn | IRInputResolvedTurn<CanonicalOpenAIResponsesInputItem[]>)[] = [];
  for (const turn of partitionGeminiGenerateContentTurns(payload.contents ?? [])) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('geminiGenerateContent', 'openaiResponses', turn.items, codec, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest, collectGeminiGenerateContentReplayContents);
      if (roundTrip !== undefined) {
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        for (const item of roundTrip.turn) {
          if (item.type !== 'function_call' && item.type !== 'custom_tool_call') continue;
          unmatchedToolCallIds[item.name] ??= [];
          unmatchedToolCallIds[item.name].push(item.call_id);
        }
        contentIndex += turn.items.length;
        continue;
      }
      if (geminiGenerateContentDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('geminiGenerateContent', 'openaiResponses');
    }
    pieces.push(geminiGenerateContentTurnToIR(turn, contentIndex, unmatchedToolCallIds, 'OpenAI Responses'));
    contentIndex += turn.items.length;
  }

  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { input.push(...piece.turn); continue; }
    input.push(...openaiResponsesFromIR({ turns: piece.turns }, false).input);
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
      request.tool_choice = { type: 'function', name: intent.name };
      break;
    }
  }

  return request;
};
