import {
  geminiFunctionCallingIntent,
  geminiFunctionCallPart,
  geminiFunctionDeclarations,
  geminiFunctionResponsePart,
  geminiInlineDataUrl,
  geminiPartKind,
  geminiPartText,
  geminiReasoningEffort,
  geminiReasoningId,
  geminiText,
  geminiThoughtText,
  type GeminiToolCallIds,
  geminiVisibleText,
} from '../shared/gemini-via/gemini.ts';
import { type CanonicalResponsesPayload } from '../shared/via-responses/responses-items.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { GeminiContent, GeminiPayload, GeminiGenerationConfig, GeminiPart } from '@floway-dev/protocols/gemini';
import type { ResponsesInputContent, ResponsesInputItem, ResponsesTool } from '@floway-dev/protocols/responses';

const flushPendingContent = (input: ResponsesInputItem[], pending: ResponsesInputContent[], role: 'user' | 'assistant'): void => {
  if (pending.length === 0) return;
  input.push({ type: 'message', role, content: [...pending] });
  pending.length = 0;
};

const inlineDataToInputImage = (part: GeminiPart): ResponsesInputContent | null => {
  const imageUrl = geminiInlineDataUrl(part);
  if (imageUrl === null) return null;

  return {
    type: 'input_image',
    image_url: imageUrl,
    detail: 'auto',
  };
};

const buildUserInputItems = (content: GeminiContent, turnIndex: number, unmatchedToolCallIds: GeminiToolCallIds): ResponsesInputItem[] => {
  const input: ResponsesInputItem[] = [];
  const pendingContent: ResponsesInputContent[] = [];

  content.parts.forEach((part, partIndex) => {
    const kind = geminiPartKind(part);
    switch (kind) {
    case null:
      return;
    case 'function_response': {
      const { response, id } = geminiFunctionResponsePart(part, unmatchedToolCallIds, turnIndex, partIndex)!;
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
      const text = geminiPartText(part);
      if (text !== null) pendingContent.push({ type: 'input_text', text });
      return;
    }
    case 'inline_data': {
      const image = inlineDataToInputImage(part);
      if (image) pendingContent.push(image);
      return;
    }
    default:
      throw new TranslatorInputError(`"${kind}" parts are not supported in user content.`);
    }
  });

  flushPendingContent(input, pendingContent, 'user');
  return input;
};

const buildAssistantInputItems = (content: GeminiContent, turnIndex: number, unmatchedToolCallIds: GeminiToolCallIds): ResponsesInputItem[] => {
  const input: ResponsesInputItem[] = [];
  const pendingContent: ResponsesInputContent[] = [];

  content.parts.forEach((part, partIndex) => {
    const kind = geminiPartKind(part);
    switch (kind) {
    case null:
      return;
    case 'function_call': {
      const { call, id } = geminiFunctionCallPart(part, unmatchedToolCallIds, turnIndex, partIndex)!;
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
      const thoughtText = geminiThoughtText(part);
      if (thoughtText !== null) {
        flushPendingContent(input, pendingContent, 'assistant');
        input.push({
          type: 'reasoning',
          id: geminiReasoningId(turnIndex, partIndex),
          summary: [{ type: 'summary_text', text: thoughtText }],
        });
        return;
      }
      const visible = geminiVisibleText(part);
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

const applyGenerationConfig = (request: CanonicalResponsesPayload, generationConfig?: GeminiGenerationConfig): void => {
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

  if (generationConfig.responseSchema !== undefined) {
    request.text = {
      ...request.text,
      format: {
        type: 'json_schema',
        json_schema: {
          name: 'gemini_response',
          schema: generationConfig.responseSchema,
        },
      },
    };
  } else if (generationConfig.responseMimeType === 'application/json') {
    request.text = { ...request.text, format: { type: 'json_object' } };
  }

  const effort = geminiReasoningEffort(generationConfig.thinkingConfig);
  if (!effort) return;

  request.reasoning = {
    effort,
    ...(effort !== 'none' && generationConfig.thinkingConfig?.includeThoughts === true ? { summary: 'detailed' as const } : {}),
  };
};

const buildTools = (payload: GeminiPayload): ResponsesTool[] | undefined => {
  const tools = geminiFunctionDeclarations(payload, 'any').map(declaration => ({
    type: 'function' as const,
    name: declaration.name,
    ...(declaration.description !== undefined ? { description: declaration.description } : {}),
    parameters: declaration.parameters ?? { type: 'object', properties: {} },
    strict: false,
  }));

  return tools.length ? tools : undefined;
};

export const buildTargetRequest = (payload: GeminiPayload, model: string): CanonicalResponsesPayload => {
  const request: CanonicalResponsesPayload = {
    model,
    stream: true,
    input: [],
  };
  const unmatchedToolCallIds: GeminiToolCallIds = {};

  const instructions = geminiText(payload.systemInstruction);
  if (instructions !== null) request.instructions = instructions;

  const input = request.input as ResponsesInputItem[];
  payload.contents?.forEach((content, turnIndex) => {
    switch (content.role) {
    case 'model':
      input.push(...buildAssistantInputItems(content, turnIndex, unmatchedToolCallIds));
      return;
    case 'user':
    case undefined:
      input.push(...buildUserInputItems(content, turnIndex, unmatchedToolCallIds));
      return;
    default:
      throw new TranslatorInputError(`"${(content as { role: string }).role}" is not a supported content role.`);
    }
  });

  applyGenerationConfig(request, payload.generationConfig);

  const tools = buildTools(payload);
  if (tools) {
    request.tools = tools;

    const intent = geminiFunctionCallingIntent(payload.toolConfig?.functionCallingConfig);
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
