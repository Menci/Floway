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
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsContentPart, OpenAIChatCompletionsMessage, OpenAIChatCompletionsTool, OpenAIChatCompletionsToolCall } from '@floway-dev/protocols/openai-chat-completions';

const latestOpaque = (current: string | null, signature?: string): string | null => (typeof signature === 'string' ? signature : current);

const inlineDataToContentPart = (part: GeminiGenerateContentPart): OpenAIChatCompletionsContentPart | null => {
  const url = geminiGenerateContentInlineDataUrl(part);
  if (url === null) return null;

  return {
    type: 'image_url',
    image_url: { url },
  };
};

const textToContentPart = (text: string): OpenAIChatCompletionsContentPart => ({
  type: 'text',
  text,
});

const contentFromParts = (parts: GeminiGenerateContentPart[]): string | OpenAIChatCompletionsContentPart[] | null => {
  const textParts = parts.map(geminiGenerateContentPartText).filter((text): text is string => text !== null);
  const mediaParts = parts.map(inlineDataToContentPart).filter((part): part is OpenAIChatCompletionsContentPart => part !== null);

  if (!textParts.length && !mediaParts.length) return null;
  if (!mediaParts.length) return textParts.join('\n\n');

  return parts.flatMap(part => {
    const text = geminiGenerateContentPartText(part);
    if (text !== null) return [textToContentPart(text)];

    const media = inlineDataToContentPart(part);
    return media ? [media] : [];
  });
};

const buildAssistantMessage = (content: GeminiGenerateContentContent, turnIndex: number, unmatchedToolCallIds: GeminiGenerateContentToolCallIds): OpenAIChatCompletionsMessage | null => {
  const visibleParts: GeminiGenerateContentPart[] = [];
  const thoughtTexts: string[] = [];
  const toolCalls: OpenAIChatCompletionsToolCall[] = [];
  let reasoningOpaque: string | null = null;

  content.parts.forEach((part, partIndex) => {
    reasoningOpaque = latestOpaque(reasoningOpaque, part.thoughtSignature);

    const kind = geminiGenerateContentPartKind(part);
    switch (kind) {
    case null:
      return;
    case 'function_call': {
      const { call, id } = geminiGenerateContentFunctionCallPart(part, unmatchedToolCallIds, turnIndex, partIndex)!;
      toolCalls.push({
        id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.args),
        },
      });
      return;
    }
    case 'text': {
      const thoughtText = geminiGenerateContentThoughtText(part);
      if (thoughtText !== null) {
        thoughtTexts.push(thoughtText);
        return;
      }
      if (geminiGenerateContentVisibleText(part) !== null) visibleParts.push(part);
      return;
    }
    case 'inline_data':
      visibleParts.push(part);
      return;
    default:
      throw new TranslatorInputError(`"${kind}" parts are not supported in model content.`);
    }
  });

  const message: OpenAIChatCompletionsMessage = {
    role: 'assistant',
    content: contentFromParts(visibleParts),
  };

  if (toolCalls.length) message.tool_calls = toolCalls;
  if (thoughtTexts.length) message.reasoning_text = thoughtTexts.join('\n\n');
  if (reasoningOpaque !== null) message.reasoning_opaque = reasoningOpaque;

  return message.content !== null || message.tool_calls?.length || message.reasoning_text !== undefined || message.reasoning_opaque !== undefined ? message : null;
};

const buildToolMessage = (part: GeminiGenerateContentPart, turnIndex: number, partIndex: number, unmatchedToolCallIds: GeminiGenerateContentToolCallIds): OpenAIChatCompletionsMessage => {
  const { response, id } = geminiGenerateContentFunctionResponsePart(part, unmatchedToolCallIds, turnIndex, partIndex)!;

  return {
    role: 'tool',
    tool_call_id: id,
    content: JSON.stringify(response.response),
  };
};

const buildUserMessages = (content: GeminiGenerateContentContent, turnIndex: number, unmatchedToolCallIds: GeminiGenerateContentToolCallIds): OpenAIChatCompletionsMessage[] => {
  const messages: OpenAIChatCompletionsMessage[] = [];
  let pendingParts: GeminiGenerateContentPart[] = [];

  const flushUserParts = (): void => {
    const chatContent = contentFromParts(pendingParts);
    pendingParts = [];
    if (chatContent === null) return;

    messages.push({ role: 'user', content: chatContent });
  };

  content.parts.forEach((part, partIndex) => {
    const kind = geminiGenerateContentPartKind(part);
    switch (kind) {
    case null:
      return;
    case 'function_response':
      flushUserParts();
      messages.push(buildToolMessage(part, turnIndex, partIndex, unmatchedToolCallIds));
      return;
    case 'text':
    case 'inline_data':
      pendingParts.push(part);
      return;
    default:
      throw new TranslatorInputError(`"${kind}" parts are not supported in user content.`);
    }
  });

  flushUserParts();
  return messages;
};

const applyGenerationConfig = (request: OpenAIChatCompletionsPayload, generationConfig?: GeminiGenerateContentGenerationConfig): void => {
  if (!generationConfig) return;

  if (generationConfig.maxOutputTokens !== undefined) {
    request.max_tokens = generationConfig.maxOutputTokens;
  }
  if (generationConfig.temperature !== undefined) {
    request.temperature = generationConfig.temperature;
  }
  if (generationConfig.topP !== undefined) {
    request.top_p = generationConfig.topP;
  }
  if (generationConfig.stopSequences !== undefined) {
    request.stop = generationConfig.stopSequences;
  }
  if (generationConfig.candidateCount !== undefined) {
    request.n = generationConfig.candidateCount;
  }
  if (generationConfig.presencePenalty !== undefined) {
    request.presence_penalty = generationConfig.presencePenalty;
  }
  if (generationConfig.frequencyPenalty !== undefined) {
    request.frequency_penalty = generationConfig.frequencyPenalty;
  }
  if (generationConfig.seed !== undefined) {
    request.seed = generationConfig.seed;
  }

  if (generationConfig.responseSchema !== undefined) {
    request.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'gemini_response',
        schema: generationConfig.responseSchema,
      },
    };
  } else if (generationConfig.responseMimeType === 'application/json') {
    request.response_format = { type: 'json_object' };
  }

  const reasoningEffort = geminiGenerateContentReasoningEffort(generationConfig.thinkingConfig);
  if (reasoningEffort !== null) request.reasoning_effort = reasoningEffort;
};

const buildTools = (payload: GeminiGenerateContentPayload): OpenAIChatCompletionsTool[] | undefined => {
  const tools = geminiGenerateContentFunctionDeclarations(payload, 'any').map(declaration => ({
    type: 'function' as const,
    function: {
      name: declaration.name,
      ...(declaration.description !== undefined ? { description: declaration.description } : {}),
      ...(declaration.parameters !== undefined ? { parameters: declaration.parameters } : {}),
    },
  }));

  return tools.length ? tools : undefined;
};

export const buildTargetRequest = (payload: GeminiGenerateContentPayload, model: string): OpenAIChatCompletionsPayload => {
  const request: OpenAIChatCompletionsPayload = {
    model,
    stream: true,
    messages: [],
  };
  const unmatchedToolCallIds: GeminiGenerateContentToolCallIds = {};

  const systemText = geminiGenerateContentText(payload.systemInstruction);
  if (systemText !== null) {
    request.messages.push({ role: 'system', content: systemText });
  }

  payload.contents?.forEach((content, turnIndex) => {
    switch (content.role) {
    case 'model': {
      const message = buildAssistantMessage(content, turnIndex, unmatchedToolCallIds);
      if (message) request.messages.push(message);
      return;
    }
    case 'user':
    case undefined:
      request.messages.push(...buildUserMessages(content, turnIndex, unmatchedToolCallIds));
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
      request.tool_choice = {
        type: 'function',
        function: { name: intent.name },
      };
      break;
    }
  }

  return request;
};
