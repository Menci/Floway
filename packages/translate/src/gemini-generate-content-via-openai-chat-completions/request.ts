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
  geminiGenerateContentThoughtText,
  type GeminiGenerateContentToolCallIds,
  geminiGenerateContentVisibleText,
} from '../shared/gemini-generate-content-via/gemini-generate-content.ts';
import { geminiFunctionParameters, geminiResponseSchema } from '../shared/gemini-generate-content-via/schema.ts';
import {
  cleanGeminiGenerateContentAssistantTurn,
  inspectGeminiGenerateContentAssistantTurn,
  partitionGeminiGenerateContentTurns,
  prepareIRRoundTripAssistantTurn,
  verifyGeminiGenerateContentReplayCheck,
  type PreparedIRRoundTripAssistantTurn,
} from '../shared/ir/round-trip/index.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { AssistantTurnSidecarCodec } from '../types.ts';
import type { GeminiGenerateContentContent, GeminiGenerateContentPayload, GeminiGenerateContentGenerationConfig, GeminiGenerateContentPart } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsUserContentPart, OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage, OpenAIChatCompletionsTool, OpenAIChatCompletionsToolCall } from '@floway-dev/protocols/openai-chat-completions';

const latestOpaque = (current: string | null, signature?: string): string | null => (typeof signature === 'string' ? signature : current);

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

type PreparedGeminiAssistantTurn = PreparedIRRoundTripAssistantTurn<GeminiGenerateContentContent[], 'openaiChatCompletions'>;
type RestoredChatAssistantTurn = Extract<PreparedGeminiAssistantTurn, { kind: 'target' }>['turn'];

interface RestoredGeminiAssistantTurn { sourceCount: number; turn: RestoredChatAssistantTurn }

const buildTargetRequestWithReplay = (
  payload: GeminiGenerateContentPayload,
  model: string,
  restoredTurns: ReadonlyMap<number, RestoredGeminiAssistantTurn>,
): OpenAIChatCompletionsPayload => {
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

  for (let turnIndex = 0; turnIndex < (payload.contents?.length ?? 0); turnIndex++) {
    const restored = restoredTurns.get(turnIndex);
    if (restored !== undefined) {
      request.messages.push(restored.turn as OpenAIChatCompletionsMessage);
      for (const call of restored.turn.tool_calls ?? []) {
        const name = call.type === 'function' ? call.function.name : call.custom.name;
        unmatchedToolCallIds[name] ??= [];
        unmatchedToolCallIds[name].push(call.id);
      }
      turnIndex += restored.sourceCount - 1;
      continue;
    }
    const content = payload.contents![turnIndex];
    if ((content.parts?.length ?? 0) === 0 && (content.role === 'model' || content.role === 'user' || content.role === undefined)) {
      request.messages.push({ role: content.role === 'model' ? 'assistant' : 'user', content: '' });
      continue;
    }
    switch (content.role) {
    case 'model': {
      const message = buildAssistantMessage(content, turnIndex, unmatchedToolCallIds);
      if (message) request.messages.push(message);
      continue;
    }
    case 'user':
    case undefined:
      request.messages.push(...buildUserMessages(content, turnIndex, unmatchedToolCallIds));
      continue;
    default:
      throw new TranslatorInputError(`"${(content as { role: string }).role}" is not a supported content role.`);
    }
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

export const buildTargetRequest = (payload: GeminiGenerateContentPayload, model: string): OpenAIChatCompletionsPayload => buildTargetRequestWithReplay(payload, model, new Map());

export const buildRoundTripTargetRequest = async (payload: GeminiGenerateContentPayload, model: string, codec: AssistantTurnSidecarCodec): Promise<OpenAIChatCompletionsPayload> => {
  const contents = [...(payload.contents ?? [])];
  const restoredTurns = new Map<number, RestoredGeminiAssistantTurn>();
  let contentIndex = 0;
  for (const turn of partitionGeminiGenerateContentTurns(payload.contents ?? [])) {
    const start = contentIndex;
    contentIndex += turn.items.length;
    if (turn.role !== 'assistant') continue;
    const prepared = await prepareIRRoundTripAssistantTurn(
      'geminiGenerateContent',
      'openaiChatCompletions',
      turn.items,
      codec,
      inspectGeminiGenerateContentAssistantTurn,
      verifyGeminiGenerateContentReplayCheck,
      cleanGeminiGenerateContentAssistantTurn,
    );
    if (prepared.kind === 'target') restoredTurns.set(start, { sourceCount: turn.items.length, turn: prepared.turn });
    else prepared.turn.forEach((content, index) => { contents[start + index] = content; });
  }
  return buildTargetRequestWithReplay({ ...payload, contents }, model, restoredTurns);
};
