import { klona } from 'klona/json';

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
  type GeminiGenerateContentToolCallIds,
  geminiGenerateContentVisibleText,
} from '../shared/gemini-generate-content-via/gemini-generate-content.ts';
import { geminiFunctionParameters, geminiResponseSchema } from '../shared/gemini-generate-content-via/schema.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPayload, GeminiGenerateContentGenerationConfig, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';
import { OpenAIChatCompletionsAssistantMessagePrivate, type OpenAIChatCompletionsAssistantMessage, type OpenAIChatCompletionsUserContentPart, type OpenAIChatCompletionsPayload, type OpenAIChatCompletionsMessage, type OpenAIChatCompletionsTool } from '@floway-dev/protocols/openai-chat-completions';

const inlineDataToContentPart = (part: GeminiGenerateContentPart): OpenAIChatCompletionsUserContentPart | null => {
  const url = geminiGenerateContentInlineDataUrl(part);
  if (url === null) return null;

  return {
    type: 'image_url',
    image_url: { url },
  };
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

type AssistantDraft = OpenAIChatCompletionsAssistantMessage & { content: string | null };

const appendAssistantPart = (message: AssistantDraft, part: GeminiGenerateContentPart, turnIndex: number, partIndex: number, unmatchedToolCallIds: GeminiGenerateContentToolCallIds): void => {
  const kind = geminiGenerateContentPartKind(part);
  switch (kind) {
  case null:
    return;
  case 'function_call': {
    const { call, id } = geminiGenerateContentFunctionCallPart(part, unmatchedToolCallIds, turnIndex, partIndex)!;
    (message.tool_calls ??= []).push({ id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } });
    return;
  }
  case 'text': {
    const text = geminiGenerateContentVisibleText(part);
    if (text !== null) message.content = (message.content ?? '') + text;
    return;
  }
  case 'inline_data':
    throw new TranslatorInputError('Cannot translate image content in a model turn to Chat assistant content.');
  default:
    throw new TranslatorInputError(`"${kind}" parts are not supported in model content.`);
  }
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

export const buildTargetRequest = (payload: GeminiGenerateContentPayload, model: string, decoded: ReadonlyMap<GeminiGenerateContentPart, OpenAIChatCompletionsAssistantMessagePrivate>): OpenAIChatCompletionsPayload => {
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

  const pending: AssistantDraft[] = [];
  const flushForeign = () => {
    for (const message of pending) if (message.content !== null || message.tool_calls !== undefined) request.messages.push(message);
    pending.length = 0;
  };
  const flushOwned = (privateState: OpenAIChatCompletionsAssistantMessagePrivate) => {
    const message = pending[0];
    for (let index = 1; index < pending.length; index++) {
      const next = pending[index];
      if (next.content !== null) message.content = (message.content ?? '') + next.content;
      if (next.tool_calls !== undefined) (message.tool_calls ??= []).push(...next.tool_calls);
    }
    message[OpenAIChatCompletionsAssistantMessagePrivate] = privateState;
    request.messages.push(message);
    pending.length = 0;
  };

  payload.contents?.forEach((content, turnIndex) => {
    switch (content.role) {
    case 'model': {
      let message: AssistantDraft | undefined;
      (content.parts ?? []).forEach((part, partIndex) => {
        if (message === undefined) {
          message = { role: 'assistant', content: null };
          pending.push(message);
        }
        appendAssistantPart(message, part, turnIndex, partIndex, unmatchedToolCallIds);
        const privateState = decoded.get(part);
        if (privateState !== undefined) {
          flushOwned(privateState);
          message = undefined;
        }
      });
      return;
    }
    case 'user':
    case undefined:
      flushForeign();
      request.messages.push(...buildUserMessages(content, turnIndex, unmatchedToolCallIds));
      return;
    default:
      throw new TranslatorInputError(`"${(content as { role: string }).role}" is not a supported content role.`);
    }
  });
  flushForeign();

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
