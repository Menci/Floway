import {
  geminiFunctionCallingIntent,
  geminiFunctionCallPart,
  geminiFunctionDeclarations,
  geminiFunctionResponsePart,
  geminiInlineDataUrl,
  geminiPartText,
  geminiReasoningEffort,
  geminiReasoningId,
  geminiText,
  geminiThoughtText,
  type GeminiToolCallIds,
  geminiVisibleText,
} from '../shared/gemini-via/gemini.ts';
import type { GeminiGenerateContentRequest, GeminiGenerationConfig, GeminiPart } from '@floway-dev/protocols/gemini';
import type { ResponseInputContent, ResponseInputItem, ResponsesPayload, ResponseTool } from '@floway-dev/protocols/responses';

const flushPendingContent = (input: ResponseInputItem[], pending: ResponseInputContent[], role: 'user' | 'assistant'): void => {
  if (pending.length === 0) return;
  input.push({ type: 'message', role, content: [...pending] });
  pending.length = 0;
};

const inlineDataToInputImage = (part: GeminiPart): ResponseInputContent | null => {
  const imageUrl = geminiInlineDataUrl(part);
  if (imageUrl === null) return null;

  return {
    type: 'input_image',
    image_url: imageUrl,
    detail: 'auto',
  };
};

const buildFunctionCallOutput = (part: GeminiPart, turnIndex: number, partIndex: number, unmatchedToolCallIds: GeminiToolCallIds): ResponseInputItem | null => {
  const functionResponsePart = geminiFunctionResponsePart(part, unmatchedToolCallIds, turnIndex, partIndex);
  if (!functionResponsePart) return null;

  return {
    type: 'function_call_output',
    call_id: functionResponsePart.id,
    output: JSON.stringify(functionResponsePart.response.response),
    status: 'completed',
  };
};

const buildFunctionCall = (part: GeminiPart, turnIndex: number, partIndex: number, unmatchedToolCallIds: GeminiToolCallIds): ResponseInputItem | null => {
  const functionCallPart = geminiFunctionCallPart(part, unmatchedToolCallIds, turnIndex, partIndex);
  if (!functionCallPart) return null;

  return {
    type: 'function_call',
    call_id: functionCallPart.id,
    name: functionCallPart.call.name,
    arguments: JSON.stringify(functionCallPart.call.args),
    status: 'completed',
  };
};

const buildReasoningItem = (part: GeminiPart, turnIndex: number, partIndex: number): ResponseInputItem | null => {
  const text = geminiThoughtText(part) ?? '';

  if (!text) return null;

  return {
    type: 'reasoning',
    id: geminiReasoningId(turnIndex, partIndex),
    summary: text ? [{ type: 'summary_text', text }] : [],
  };
};

const buildUserInputItems = (content: NonNullable<GeminiGenerateContentRequest['contents']>[number], turnIndex: number, unmatchedToolCallIds: GeminiToolCallIds): ResponseInputItem[] => {
  const input: ResponseInputItem[] = [];
  const pendingContent: ResponseInputContent[] = [];

  content.parts.forEach((part, partIndex) => {
    const functionOutput = buildFunctionCallOutput(part, turnIndex, partIndex, unmatchedToolCallIds);
    if (functionOutput) {
      flushPendingContent(input, pendingContent, 'user');
      input.push(functionOutput);
      return;
    }

    const text = geminiPartText(part);
    if (text !== null) {
      pendingContent.push({ type: 'input_text', text });
      return;
    }

    const image = inlineDataToInputImage(part);
    if (image) pendingContent.push(image);
  });

  flushPendingContent(input, pendingContent, 'user');
  return input;
};

const buildAssistantInputItems = (content: NonNullable<GeminiGenerateContentRequest['contents']>[number], turnIndex: number, unmatchedToolCallIds: GeminiToolCallIds): ResponseInputItem[] => {
  const input: ResponseInputItem[] = [];
  const pendingContent: ResponseInputContent[] = [];

  content.parts.forEach((part, partIndex) => {
    const reasoning = buildReasoningItem(part, turnIndex, partIndex);
    if (reasoning) {
      flushPendingContent(input, pendingContent, 'assistant');
      input.push(reasoning);

      if (part.thought === true && !part.functionCall) return;
    }

    const functionCall = buildFunctionCall(part, turnIndex, partIndex, unmatchedToolCallIds);
    if (functionCall) {
      flushPendingContent(input, pendingContent, 'assistant');
      input.push(functionCall);
      return;
    }

    const text = geminiVisibleText(part);
    if (text !== null) pendingContent.push({ type: 'output_text', text });
  });

  flushPendingContent(input, pendingContent, 'assistant');
  return input;
};

const applyGenerationConfig = (request: ResponsesPayload, generationConfig?: GeminiGenerationConfig): void => {
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
      format: {
        type: 'json_schema',
        json_schema: {
          name: 'gemini_response',
          schema: generationConfig.responseSchema,
        },
      },
    };
  } else if (generationConfig.responseMimeType === 'application/json') {
    request.text = { format: { type: 'json_object' } };
  }

  const effort = geminiReasoningEffort(generationConfig.thinkingConfig);
  if (!effort) return;

  request.reasoning = {
    effort,
    ...(effort !== 'none' && generationConfig.thinkingConfig?.includeThoughts === true ? { summary: 'detailed' as const } : {}),
  };
};

const buildTools = (payload: GeminiGenerateContentRequest): ResponseTool[] | undefined => {
  const tools = geminiFunctionDeclarations(payload, 'any').map(declaration => ({
    type: 'function' as const,
    name: declaration.name,
    ...(declaration.description !== undefined ? { description: declaration.description } : {}),
    parameters: declaration.parameters ?? { type: 'object', properties: {} },
    strict: false,
  }));

  return tools.length ? tools : undefined;
};

export const buildTargetRequest = (payload: GeminiGenerateContentRequest, model: string): ResponsesPayload => {
  const request: ResponsesPayload = {
    model,
    stream: true,
    input: [],
  };
  const unmatchedToolCallIds: GeminiToolCallIds = {};

  const instructions = geminiText(payload.systemInstruction);
  if (instructions !== null) request.instructions = instructions;

  const input = request.input as ResponseInputItem[];
  payload.contents?.forEach((content, turnIndex) => {
    input.push(...(content.role === 'model' ? buildAssistantInputItems(content, turnIndex, unmatchedToolCallIds) : buildUserInputItems(content, turnIndex, unmatchedToolCallIds)));
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
