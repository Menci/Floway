import { klona } from 'klona/json';

import { TranslatorInputError } from '../../../translator-input-error.ts';
import { geminiGenerateContentInlineData, geminiGenerateContentPartKind, geminiGenerateContentPartText, geminiGenerateContentText, geminiGenerateContentThoughtText, geminiGenerateContentVisibleText } from '../as-source/content.ts';
import { partitionGeminiGenerateContentTurns } from '../as-source/conversation-turns.ts';
import { geminiGenerateContentReasoningEffort } from '../as-source/reasoning.ts';
import { geminiFunctionParameters, geminiResponseSchema } from '../as-source/schema.ts';
import { geminiGenerateContentFunctionCallingIntent, geminiGenerateContentFunctionCallPart, geminiGenerateContentFunctionDeclarations, geminiGenerateContentFunctionResponsePart, type GeminiGenerateContentToolCallIds } from '../as-source/tools.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPayload, GeminiGenerateContentGenerationConfig, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsUserContentPart, OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage, OpenAIChatCompletionsTool, OpenAIChatCompletionsToolCall } from '@floway-dev/protocols/openai-chat-completions';

const latestOpaque = (current: string | null, signature?: string): string | null => (typeof signature === 'string' ? signature : current);

const inlineDataToContentPart = (part: GeminiGenerateContentPart): OpenAIChatCompletionsUserContentPart | null => {
  const inlineData = geminiGenerateContentInlineData(part);
  if (inlineData === null) return null;

  switch (inlineData.kind) {
  case 'image':
    return {
      type: 'image_url',
      image_url: { url: `data:${inlineData.mimeType};base64,${inlineData.data}` },
    };
  case 'pdf':
    return {
      type: 'file',
      file: { file_data: `data:${inlineData.mimeType};base64,${inlineData.data}` },
    };
  case 'audio':
    return {
      type: 'input_audio',
      input_audio: { data: inlineData.data, format: inlineData.format },
    };
  case 'unsupported':
    throw new TranslatorInputError(`Cannot translate Gemini generateContent inlineData MIME type '${inlineData.mimeType}' to OpenAI Chat Completions.`);
  }
};

const textToContentPart = (text: string): OpenAIChatCompletionsUserContentPart => ({
  type: 'text',
  text,
});

const contentFromParts = (parts: GeminiGenerateContentPart[]): string | OpenAIChatCompletionsUserContentPart[] | null => {
  const textParts = parts.map(geminiGenerateContentPartText).filter((text): text is string => text !== null);
  const mediaParts = parts.map(inlineDataToContentPart).filter((part): part is OpenAIChatCompletionsUserContentPart => part !== null);

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

  (content.parts ?? []).forEach((part, partIndex) => {
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

  if (visibleParts.some(part => part.inlineData !== undefined)) throw new TranslatorInputError('Cannot translate image content in a model turn to Chat assistant content.');
  const textParts = visibleParts.map(geminiGenerateContentPartText).filter((value): value is string => value !== null);
  const message: OpenAIChatCompletionsAssistantMessageEx = {
    role: 'assistant',
    content: textParts.length > 0 ? textParts.join('\n\n') : null,
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

  (content.parts ?? []).forEach((part, partIndex) => {
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
    request.stop = klona(generationConfig.stopSequences);
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

  const schema = geminiResponseSchema(generationConfig);
  if (schema !== undefined) {
    request.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'gemini_response',
        schema,
      },
    };
  } else if (generationConfig.responseMimeType === 'application/json') {
    request.response_format = { type: 'json_object' };
  }

  const reasoningEffort = geminiGenerateContentReasoningEffort(generationConfig.thinkingConfig);
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

export const buildTargetRequest = (payload: GeminiGenerateContentPayload, model: string): OpenAIChatCompletionsPayload => {
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
  for (const turn of partitionGeminiGenerateContentTurns(payload.contents ?? [])) {
    if (turn.role === 'assistant') {
      for (const [index, content] of turn.items.entries()) {
        if ((content.parts?.length ?? 0) === 0) { request.messages.push({ role: 'assistant', content: '' }); continue; }
        const message = buildAssistantMessage(content, contentIndex + index, unmatchedToolCallIds);
        if (message) request.messages.push(message);
      }
    } else for (const [index, content] of turn.items.entries()) {
      if (content.role !== 'user' && content.role !== undefined) throw new TranslatorInputError(`"${(content as { role: string }).role}" is not a supported content role.`);
      if ((content.parts?.length ?? 0) === 0) { request.messages.push({ role: 'user', content: '' }); continue; }
      request.messages.push(...buildUserMessages(content, contentIndex + index, unmatchedToolCallIds));
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
      request.tool_choice = {
        type: 'function',
        function: { name: intent.name },
      };
      break;
    }
  }

  return request;
};
