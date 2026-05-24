import {
  geminiFunctionCallingIntent,
  geminiFunctionCallPart,
  geminiFunctionDeclarations,
  geminiFunctionResponsePart,
  geminiInlineDataUrl,
  geminiPartText,
  geminiReasoningEffort,
  geminiText,
  geminiThoughtText,
  type GeminiToolCallIds,
  geminiVisibleText,
} from '../shared/gemini-via/gemini.ts';
import type { ChatCompletionsPayload, ContentPart, Message, Tool, ToolCall } from '@floway-dev/protocols/chat-completions';
import type { GeminiContent, GeminiGenerateContentRequest, GeminiGenerationConfig, GeminiPart } from '@floway-dev/protocols/gemini';

const appendOpaque = (current: string | null, signature?: string): string | null => (typeof signature === 'string' ? `${current ?? ''}${signature}` : current);

const inlineDataToContentPart = (part: GeminiPart): ContentPart | null => {
  const url = geminiInlineDataUrl(part);
  if (url === null) return null;

  return {
    type: 'image_url',
    image_url: { url },
  };
};

const textToContentPart = (text: string): ContentPart => ({
  type: 'text',
  text,
});

const contentFromParts = (parts: GeminiPart[]): string | ContentPart[] | null => {
  const textParts = parts.map(geminiPartText).filter((text): text is string => text !== null);
  const mediaParts = parts.map(inlineDataToContentPart).filter((part): part is ContentPart => part !== null);

  if (!textParts.length && !mediaParts.length) return null;
  if (!mediaParts.length) return textParts.join('\n\n');

  return parts.flatMap(part => {
    const text = geminiPartText(part);
    if (text !== null) return [textToContentPart(text)];

    const media = inlineDataToContentPart(part);
    return media ? [media] : [];
  });
};

const buildAssistantMessage = (content: GeminiContent, turnIndex: number, unmatchedToolCallIds: GeminiToolCallIds): Message | null => {
  const visibleParts: GeminiPart[] = [];
  const thoughtTexts: string[] = [];
  const toolCalls: ToolCall[] = [];
  let reasoningOpaque: string | null = null;

  content.parts.forEach((part, partIndex) => {
    reasoningOpaque = appendOpaque(reasoningOpaque, part.thoughtSignature);

    const functionCallPart = geminiFunctionCallPart(part, unmatchedToolCallIds, turnIndex, partIndex);
    if (functionCallPart) {
      const { call, id } = functionCallPart;
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

    const thoughtText = geminiThoughtText(part);
    if (thoughtText !== null) {
      thoughtTexts.push(thoughtText);
      return;
    }

    if (geminiVisibleText(part) !== null || part.inlineData) {
      visibleParts.push(part);
    }
  });

  const message: Message = {
    role: 'assistant',
    content: contentFromParts(visibleParts),
  };

  if (toolCalls.length) message.tool_calls = toolCalls;
  if (thoughtTexts.length) message.reasoning_text = thoughtTexts.join('\n\n');
  if (reasoningOpaque !== null) message.reasoning_opaque = reasoningOpaque;

  return message.content !== null || message.tool_calls?.length || message.reasoning_text !== undefined || message.reasoning_opaque !== undefined ? message : null;
};

const buildToolMessage = (part: GeminiPart, turnIndex: number, partIndex: number, unmatchedToolCallIds: GeminiToolCallIds): Message | null => {
  const functionResponsePart = geminiFunctionResponsePart(part, unmatchedToolCallIds, turnIndex, partIndex);
  if (!functionResponsePart) return null;

  return {
    role: 'tool',
    tool_call_id: functionResponsePart.id,
    content: JSON.stringify(functionResponsePart.response.response),
  };
};

const buildUserMessages = (content: GeminiContent, turnIndex: number, unmatchedToolCallIds: GeminiToolCallIds): Message[] => {
  const messages: Message[] = [];
  let pendingParts: GeminiPart[] = [];

  const flushUserParts = (): void => {
    const chatContent = contentFromParts(pendingParts);
    pendingParts = [];
    if (chatContent === null) return;

    messages.push({ role: 'user', content: chatContent });
  };

  content.parts.forEach((part, partIndex) => {
    const toolMessage = buildToolMessage(part, turnIndex, partIndex, unmatchedToolCallIds);
    if (toolMessage) {
      flushUserParts();
      messages.push(toolMessage);
      return;
    }

    if (part.text !== undefined || part.inlineData) pendingParts.push(part);
  });

  flushUserParts();
  return messages;
};

const applyGenerationConfig = (request: ChatCompletionsPayload, generationConfig?: GeminiGenerationConfig): void => {
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

  const reasoningEffort = geminiReasoningEffort(generationConfig.thinkingConfig);
  if (reasoningEffort) request.reasoning_effort = reasoningEffort;
};

const buildTools = (payload: GeminiGenerateContentRequest): Tool[] | undefined => {
  const tools = geminiFunctionDeclarations(payload, 'any').map(declaration => ({
    type: 'function' as const,
    function: {
      name: declaration.name,
      ...(declaration.description !== undefined ? { description: declaration.description } : {}),
      ...(declaration.parameters !== undefined ? { parameters: declaration.parameters } : {}),
    },
  }));

  return tools.length ? tools : undefined;
};

export const buildTargetRequest = (payload: GeminiGenerateContentRequest, model: string): ChatCompletionsPayload => {
  const request: ChatCompletionsPayload = {
    model,
    stream: true,
    messages: [],
  };
  const unmatchedToolCallIds: GeminiToolCallIds = {};

  const systemText = geminiText(payload.systemInstruction);
  if (systemText !== null) {
    request.messages.push({ role: 'system', content: systemText });
  }

  payload.contents?.forEach((content, turnIndex) => {
    if (content.role === 'model') {
      const message = buildAssistantMessage(content, turnIndex, unmatchedToolCallIds);
      if (message) request.messages.push(message);
      return;
    }

    request.messages.push(...buildUserMessages(content, turnIndex, unmatchedToolCallIds));
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
      request.tool_choice = {
        type: 'function',
        function: { name: intent.name },
      };
      break;
    }
  }

  return request;
};
