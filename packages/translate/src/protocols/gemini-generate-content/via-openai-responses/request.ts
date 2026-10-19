import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { SidecarCodec } from '../../../types.ts';
import { geminiGenerateContentInlineData, geminiGenerateContentPartKind, geminiGenerateContentPartText, geminiGenerateContentText, geminiGenerateContentThoughtText, geminiGenerateContentVisibleText } from '../as-source/content.ts';
import { partitionGeminiGenerateContentTurns } from '../as-source/conversation-turns.ts';
import { geminiGenerateContentReasoningEffort } from '../as-source/reasoning.ts';
import { collectGeminiGenerateContentReplayContents, hasGeminiGenerateContentThoughtSignature, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from '../as-source/round-trip.ts';
import { geminiFunctionParameters, geminiResponseSchema } from '../as-source/schema.ts';
import { geminiGenerateContentFunctionCallingIntent, geminiGenerateContentFunctionCallPart, geminiGenerateContentFunctionDeclarations, geminiGenerateContentFunctionResponsePart, type GeminiGenerateContentToolCallIds } from '../as-source/tools.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPayload, GeminiGenerateContentGenerationConfig, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputContent, CanonicalOpenAIResponsesInputItem, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';

const geminiGenerateContentReasoningId = (turnIndex: number, partIndex: number): string => `gemini_reasoning_${turnIndex}_${partIndex}`;

const flushPendingContent = (input: CanonicalOpenAIResponsesInputItem[], pending: OpenAIResponsesInputContent[], role: 'user' | 'assistant'): void => {
  if (pending.length === 0) return;
  input.push({ type: 'message', role, content: [...pending] });
  pending.length = 0;
};

const inlineDataToInputContent = (part: GeminiGenerateContentPart): OpenAIResponsesInputContent | null => {
  const inlineData = geminiGenerateContentInlineData(part);
  if (inlineData === null) return null;

  switch (inlineData.kind) {
  case 'image':
    return {
      type: 'input_image',
      image_url: `data:${inlineData.mimeType};base64,${inlineData.data}`,
    };
  case 'pdf':
    return {
      type: 'input_file',
      file_data: `data:${inlineData.mimeType};base64,${inlineData.data}`,
    };
  case 'audio':
  case 'unsupported':
    throw new TranslatorInputError(`Cannot translate Gemini generateContent inlineData MIME type '${inlineData.mimeType}' to OpenAI Responses.`);
  }
};

const buildUserInputItems = (content: GeminiGenerateContentContent, turnIndex: number, unmatchedToolCallIds: GeminiGenerateContentToolCallIds): CanonicalOpenAIResponsesInputItem[] => {
  const input: CanonicalOpenAIResponsesInputItem[] = [];
  const pendingContent: OpenAIResponsesInputContent[] = [];

  (content.parts ?? []).forEach((part, partIndex) => {
    const kind = geminiGenerateContentPartKind(part);
    switch (kind) {
    case null:
      return;
    case 'function_response': {
      const { response, id } = geminiGenerateContentFunctionResponsePart(part, unmatchedToolCallIds, turnIndex, partIndex)!;
      flushPendingContent(input, pendingContent, 'user');
      input.push({
        type: 'function_call_output',
        call_id: id,
        output: JSON.stringify(response.response),
        status: 'completed',
      });
      return;
    }
    case 'text': {
      const text = geminiGenerateContentPartText(part);
      if (text !== null) pendingContent.push({ type: 'input_text', text });
      return;
    }
    case 'inline_data': {
      const inlineData = inlineDataToInputContent(part);
      if (inlineData) pendingContent.push(inlineData);
      return;
    }
    default:
      throw new TranslatorInputError(`"${kind}" parts are not supported in user content.`);
    }
  });

  flushPendingContent(input, pendingContent, 'user');
  return input;
};

const buildAssistantInputItems = (content: GeminiGenerateContentContent, turnIndex: number, unmatchedToolCallIds: GeminiGenerateContentToolCallIds): CanonicalOpenAIResponsesInputItem[] => {
  if (hasGeminiGenerateContentThoughtSignature(content)) {
    warnDroppedUnrecognizedAssistantReasoning('geminiGenerateContent', 'openaiResponses');
  }
  const input: CanonicalOpenAIResponsesInputItem[] = [];
  const pendingContent: OpenAIResponsesInputContent[] = [];
  const parts = (content.parts ?? []).flatMap(part => {
    const kind = geminiGenerateContentPartKind(part);
    return kind === null ? [] : [{ kind, part }];
  });

  parts.forEach(({ kind, part }, partIndex) => {
    switch (kind) {
    case 'function_call': {
      const { call, id } = geminiGenerateContentFunctionCallPart(part, unmatchedToolCallIds, turnIndex, partIndex)!;
      flushPendingContent(input, pendingContent, 'assistant');
      input.push({
        type: 'function_call',
        call_id: id,
        name: call.name,
        arguments: JSON.stringify(call.args),
        status: 'completed',
      });
      return;
    }
    case 'text': {
      const thoughtText = geminiGenerateContentThoughtText(part);
      if (thoughtText !== null) {
        flushPendingContent(input, pendingContent, 'assistant');
        input.push({
          type: 'reasoning',
          id: geminiGenerateContentReasoningId(turnIndex, partIndex),
          summary: [{ type: 'summary_text', text: thoughtText }],
        });
        return;
      }
      const visible = geminiGenerateContentVisibleText(part);
      if (visible !== null) pendingContent.push({ type: 'output_text', text: visible });
      return;
    }
    default:
      throw new TranslatorInputError(`"${kind}" parts are not supported in model content.`);
    }
  });

  flushPendingContent(input, pendingContent, 'assistant');
  return input;
};

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
  for (const turn of partitionGeminiGenerateContentTurns(payload.contents ?? [])) {
    const roundTrip = turn.role === 'assistant' && await roundTripAssistantTurn('geminiGenerateContent', 'openaiResponses', turn.items, codec, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest, collectGeminiGenerateContentReplayContents);
    if (!roundTrip) {
      if (turn.role === 'assistant') {
        for (const [index, content] of turn.items.entries()) {
          if ((content.parts?.length ?? 0) === 0) { input.push({ type: 'message', role: 'assistant', content: '' }); continue; }
          input.push(...buildAssistantInputItems(content, contentIndex + index, unmatchedToolCallIds));
        }
      } else for (const [index, content] of turn.items.entries()) {
        if (content.role !== 'user' && content.role !== undefined) throw new TranslatorInputError(`"${(content as { role: string }).role}" is not a supported content role.`);
        if ((content.parts?.length ?? 0) === 0) { input.push({ type: 'message', role: 'user', content: '' }); continue; }
        input.push(...buildUserInputItems(content, contentIndex + index, unmatchedToolCallIds));
      }
    } else {
      input.push(...roundTrip.turn);
      for (const item of roundTrip.turn) {
        if (item.type !== 'function_call' && item.type !== 'custom_tool_call') continue;
        unmatchedToolCallIds[item.name] ??= [];
        unmatchedToolCallIds[item.name].push(item.call_id);
      }
    }
    contentIndex += turn.items.length;
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
