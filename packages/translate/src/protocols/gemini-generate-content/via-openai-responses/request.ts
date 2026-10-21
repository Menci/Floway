import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input-segments.ts';
import type { IRInputTurn } from '../../../ir/input.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiResponsesFromIR } from '../../openai-responses/as-target/input-from.ts';
import { geminiGenerateContentText } from '../as-source/content.ts';
import { partitionGeminiGenerateContentTurns } from '../as-source/conversation-turns.ts';
import { geminiGenerateContentReasoningEffort } from '../as-source/reasoning.ts';
import { geminiGenerateContentDropsReasoning, geminiGenerateContentTurnToIR } from '../as-source/input-to.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from '../as-source/round-trip.ts';
import { geminiFunctionParameters, geminiResponseSchema } from '../as-source/schema.ts';
import { geminiGenerateContentFunctionCallingIntent, geminiGenerateContentFunctionDeclarations, type GeminiGenerateContentToolCallIds } from '../as-source/tools.ts';
import type { GeminiGenerateContentPayload, GeminiGenerateContentGenerationConfig } from '@floway-dev/protocols/gemini-generate-content';
import type { CanonicalOpenAIResponsesPayload, CanonicalOpenAIResponsesInputItem, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';

const applyGenerationConfig = (request: CanonicalOpenAIResponsesPayload, generationConfig?: GeminiGenerateContentGenerationConfig): void => {
  if (!generationConfig) return;

  if (generationConfig.maxOutputTokens !== undefined) {
    request.max_output_tokens = generationConfig.maxOutputTokens;
  }
  if (generationConfig.temperature !== undefined) {
    request.temperature = generationConfig.temperature;
  }
  if (generationConfig.topP !== undefined) {
    request.top_p = generationConfig.topP;
  }

  const schema = geminiResponseSchema(generationConfig);
  if (schema !== undefined) {
    request.text = {
      ...request.text,
      format: {
        type: 'json_schema',
        name: 'gemini_response',
        schema,
      },
    };
  } else if (generationConfig.responseMimeType === 'application/json') {
    request.text = { ...request.text, format: { type: 'json_object' } };
  }

  const effort = geminiGenerateContentReasoningEffort(generationConfig.thinkingConfig);
  if (effort === null) return;

  request.reasoning = {
    effort,
    ...(effort !== 'none' && generationConfig.thinkingConfig?.includeThoughts === true ? { summary: 'detailed' as const } : {}),
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

  applyGenerationConfig(request, payload.generationConfig);

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
