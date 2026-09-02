import {
  geminiGenerateContentFunctionCallingIntent,
  geminiGenerateContentFunctionCallPart,
  geminiGenerateContentFunctionDeclarations,
  geminiGenerateContentFunctionResponsePart,
  geminiGenerateContentInlineDataUrl,
  geminiGenerateContentPartKind,
  geminiGenerateContentPartText,
  geminiGenerateContentReasoningEffort,
  geminiGenerateContentText,
  geminiGenerateContentThoughtText,
  type GeminiGenerateContentToolCallIds,
  geminiGenerateContentVisibleText,
} from '../shared/gemini-generate-content-via/gemini-generate-content.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPayload, GeminiGenerateContentGenerationConfig, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputContent, OpenAIResponsesInputItem, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';

const geminiGenerateContentReasoningId = (turnIndex: number, partIndex: number): string => `gemini_reasoning_${turnIndex}_${partIndex}`;

const flushPendingContent = (input: OpenAIResponsesInputItem[], pending: OpenAIResponsesInputContent[], role: 'user' | 'assistant'): void => {
  if (pending.length === 0) return;
  input.push({ type: 'message', role, content: [...pending] });
  pending.length = 0;
};

const inlineDataToInputImage = (part: GeminiGenerateContentPart): OpenAIResponsesInputContent | null => {
  const imageUrl = geminiGenerateContentInlineDataUrl(part);
  if (imageUrl === null) return null;

  return {
    type: 'input_image',
    image_url: imageUrl,
  };
};

const buildUserInputItems = (content: GeminiGenerateContentContent, turnIndex: number, unmatchedToolCallIds: GeminiGenerateContentToolCallIds): OpenAIResponsesInputItem[] => {
  const input: OpenAIResponsesInputItem[] = [];
  const pendingContent: OpenAIResponsesInputContent[] = [];

  content.parts.forEach((part, partIndex) => {
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

const buildAssistantInputItems = (content: GeminiGenerateContentContent, turnIndex: number, unmatchedToolCallIds: GeminiGenerateContentToolCallIds): OpenAIResponsesInputItem[] => {
  const input: OpenAIResponsesInputItem[] = [];
  const pendingContent: OpenAIResponsesInputContent[] = [];

  content.parts.forEach((part, partIndex) => {
    const kind = geminiGenerateContentPartKind(part);
    switch (kind) {
    case null:
      return;
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
    parameters: declaration.parameters ?? { type: 'object', properties: {} },
    strict: false,
  }));

  return tools.length ? tools : undefined;
};

export const buildTargetRequest = (payload: GeminiGenerateContentPayload, model: string): CanonicalOpenAIResponsesPayload => {
  const request: CanonicalOpenAIResponsesPayload = {
    model,
    stream: true,
    input: [],
  };
  const unmatchedToolCallIds: GeminiGenerateContentToolCallIds = {};

  const instructions = geminiGenerateContentText(payload.systemInstruction);
  if (instructions !== null) request.instructions = instructions;

  const input = request.input as OpenAIResponsesInputItem[];
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
