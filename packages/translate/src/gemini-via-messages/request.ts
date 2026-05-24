import {
  geminiFunctionCallingIntent,
  geminiFunctionCallPart,
  geminiFunctionDeclarations,
  geminiFunctionResponsePart,
  geminiInlineData,
  geminiPartText,
  geminiText,
  geminiThinkingLevelEffort,
  geminiThoughtText,
  type GeminiToolCallIds,
  geminiVisibleText,
} from '../shared/gemini-via/gemini.ts';
import { applyLastMessageCacheBreakpoint, applyLastToolCacheBreakpoint, EPHEMERAL_CACHE_CONTROL } from '../shared/via-messages/cache-breakpoints.ts';
import type { GeminiContent, GeminiGenerateContentRequest, GeminiGenerationConfig, GeminiPart, GeminiThinkingConfig } from '@floway-dev/protocols/gemini';
import {
  MESSAGES_FALLBACK_MAX_TOKENS,
  type MessagesAssistantContentBlock,
  type MessagesImageBlock,
  type MessagesPayload,
  type MessagesTextBlock,
  type MessagesTool,
  type MessagesToolResultBlock,
  type MessagesUserContentBlock,
} from '@floway-dev/protocols/messages';

const inlineDataToImageBlock = (part: GeminiPart): MessagesImageBlock | null => {
  const inlineData = geminiInlineData(part);
  if (!inlineData) return null;

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: inlineData.mimeType,
      data: inlineData.data,
    },
  };
};

const buildToolResultBlock = (part: GeminiPart, turnIndex: number, partIndex: number, unmatchedToolCallIds: GeminiToolCallIds): MessagesToolResultBlock | null => {
  const functionResponsePart = geminiFunctionResponsePart(part, unmatchedToolCallIds, turnIndex, partIndex, 'last');
  if (!functionResponsePart) return null;

  return {
    type: 'tool_result',
    tool_use_id: functionResponsePart.id,
    content: JSON.stringify(functionResponsePart.response.response),
  };
};

const buildUserMessage = (content: GeminiContent, turnIndex: number, unmatchedToolCallIds: GeminiToolCallIds): MessagesPayload['messages'][number] | null => {
  const blocks: MessagesUserContentBlock[] = [];

  content.parts.forEach((part, partIndex) => {
    const toolResult = buildToolResultBlock(part, turnIndex, partIndex, unmatchedToolCallIds);
    if (toolResult) {
      blocks.push(toolResult);
      return;
    }

    const text = geminiPartText(part);
    if (text !== null) {
      blocks.push({ type: 'text', text });
      return;
    }

    const image = inlineDataToImageBlock(part);
    if (image) blocks.push(image);
  });

  return blocks.length ? { role: 'user', content: blocks } : null;
};

const attachSignatureToThinking = (
  blocks: MessagesAssistantContentBlock[],
  signature: string | undefined,
  firstThinkingIndex: number | undefined,
  firstSignedActionIndex: number | undefined,
): void => {
  if (signature === undefined) return;

  if (firstThinkingIndex !== undefined) {
    const block = blocks[firstThinkingIndex];
    if (block?.type === 'thinking') block.signature = signature;
    return;
  }

  if (firstSignedActionIndex !== undefined) {
    blocks.splice(firstSignedActionIndex, 0, {
      type: 'redacted_thinking',
      data: signature,
    });
  }
};

const buildToolUseBlock = (part: GeminiPart, turnIndex: number, partIndex: number, unmatchedToolCallIds: GeminiToolCallIds): MessagesAssistantContentBlock | null => {
  const functionCallPart = geminiFunctionCallPart(part, unmatchedToolCallIds, turnIndex, partIndex);
  if (!functionCallPart) return null;

  return {
    type: 'tool_use',
    id: functionCallPart.id,
    name: functionCallPart.call.name,
    input: functionCallPart.call.args,
  };
};

const buildAssistantMessage = (content: GeminiContent, turnIndex: number, unmatchedToolCallIds: GeminiToolCallIds): MessagesPayload['messages'][number] | null => {
  const blocks: MessagesAssistantContentBlock[] = [];
  let firstThinkingIndex: number | undefined;
  let firstActionSignature: string | undefined;
  let firstSignedActionIndex: number | undefined;

  content.parts.forEach((part, partIndex) => {
    if (part.thoughtSignature !== undefined && firstActionSignature === undefined) {
      firstActionSignature = part.thoughtSignature;
    }

    const thoughtText = geminiThoughtText(part);
    if (thoughtText !== null) {
      firstThinkingIndex ??= blocks.length;
      blocks.push({ type: 'thinking', thinking: thoughtText });
      return;
    }

    const toolUse = buildToolUseBlock(part, turnIndex, partIndex, unmatchedToolCallIds);
    if (toolUse) {
      if (part.thoughtSignature !== undefined) {
        firstSignedActionIndex ??= blocks.length;
      }
      blocks.push(toolUse);
      return;
    }

    const text = geminiVisibleText(part);
    if (text !== null) {
      if (part.thoughtSignature !== undefined) {
        firstSignedActionIndex ??= blocks.length;
      }
      blocks.push({ type: 'text', text });
    }
  });

  attachSignatureToThinking(blocks, firstActionSignature, firstThinkingIndex, firstSignedActionIndex);

  return blocks.length ? { role: 'assistant', content: blocks } : null;
};

const applyThinkingConfig = (request: MessagesPayload, thinkingConfig?: GeminiThinkingConfig): void => {
  if (!thinkingConfig) return;

  if (thinkingConfig.thinkingBudget !== undefined) {
    if (thinkingConfig.thinkingBudget === -1) {
      request.thinking = { type: 'adaptive' };
    } else if (thinkingConfig.thinkingBudget > 0) {
      request.thinking = {
        type: 'enabled',
        budget_tokens: thinkingConfig.thinkingBudget,
      };
    } else if (thinkingConfig.thinkingBudget === 0) {
      request.thinking = { type: 'disabled' };
    }
  }

  const effort = geminiThinkingLevelEffort(thinkingConfig);
  // Spread to merge with any output_config fields a sibling helper has
  // already written (e.g. structured-output `format` from
  // applyGenerationConfig).
  if (effort !== undefined) request.output_config = { ...request.output_config, effort };
};

const applyGenerationConfig = (request: MessagesPayload, generationConfig: GeminiGenerationConfig | undefined, fallbackMaxOutputTokens: number): void => {
  request.max_tokens = generationConfig?.maxOutputTokens ?? fallbackMaxOutputTokens;

  if (!generationConfig) return;

  if (generationConfig.temperature !== undefined) {
    request.temperature = generationConfig.temperature;
  }
  if (generationConfig.topP !== undefined) {
    request.top_p = generationConfig.topP;
  }
  if (generationConfig.topK !== undefined) {
    request.top_k = generationConfig.topK;
  }
  if (generationConfig.stopSequences !== undefined) {
    request.stop_sequences = generationConfig.stopSequences;
  }
  // Gemini's `responseSchema` is the bare JSON Schema; Anthropic carries it
  // as `output_config.format = { type: 'json_schema', schema }`. `responseMimeType:
  // application/json` without a schema has no Anthropic equivalent and is
  // dropped — the routing fallback degrades gracefully rather than fails.
  if (generationConfig.responseSchema !== undefined) {
    request.output_config = {
      ...request.output_config,
      format: { type: 'json_schema', schema: generationConfig.responseSchema as Record<string, unknown> },
    };
  }

  applyThinkingConfig(request, generationConfig.thinkingConfig);
};

const inputSchemaForDeclaration = (parameters: Record<string, unknown> | undefined): Record<string, unknown> => {
  if (parameters !== undefined) return parameters;

  // MessagesClientTool requires input_schema, so parameterless Gemini function
  // declarations use the smallest object schema rather than dropping the tool.
  return { type: 'object', properties: {} };
};

const buildTools = (payload: GeminiGenerateContentRequest): MessagesTool[] | undefined => {
  const tools = geminiFunctionDeclarations(payload, 'all').map(declaration => ({
    type: 'custom' as const,
    name: declaration.name,
    ...(declaration.description !== undefined ? { description: declaration.description } : {}),
    input_schema: inputSchemaForDeclaration(declaration.parameters),
  }));

  return tools.length ? tools : undefined;
};

export const buildTargetRequest = (
  payload: GeminiGenerateContentRequest,
  model: string,
  options: { fallbackMaxOutputTokens?: number },
): MessagesPayload => {
  // Gemini can omit maxOutputTokens, but MessagesPayload requires max_tokens.
  // Prefer the model's advertised `/models` cap when one is known; otherwise
  // fall back to the gateway policy default shared with the other *-to-Messages
  // translators.
  const fallbackMaxOutputTokens = options.fallbackMaxOutputTokens ?? MESSAGES_FALLBACK_MAX_TOKENS;
  const request: MessagesPayload = {
    model,
    stream: true,
    max_tokens: fallbackMaxOutputTokens,
    messages: [],
  };
  const unmatchedToolCallIds: GeminiToolCallIds = {};

  const system = geminiText(payload.systemInstruction);
  if (system !== null) {
    const systemBlock: MessagesTextBlock = { type: 'text', text: system, cache_control: EPHEMERAL_CACHE_CONTROL };
    request.system = [systemBlock];
  }

  payload.contents?.forEach((content, turnIndex) => {
    const message = content.role === 'model' ? buildAssistantMessage(content, turnIndex, unmatchedToolCallIds) : buildUserMessage(content, turnIndex, unmatchedToolCallIds);
    if (message) request.messages.push(message);
  });

  applyGenerationConfig(request, payload.generationConfig, fallbackMaxOutputTokens);

  const tools = buildTools(payload);
  if (tools) request.tools = tools;
  applyLastToolCacheBreakpoint(request.tools);
  applyLastMessageCacheBreakpoint(request.messages);

  const intent = geminiFunctionCallingIntent(payload.toolConfig?.functionCallingConfig);
  switch (intent?.type) {
  case 'none':
    request.tool_choice = { type: 'none' };
    break;
  case 'auto':
    request.tool_choice = { type: 'auto' };
    break;
  case 'any':
    request.tool_choice = { type: 'any' };
    break;
  case 'named':
    request.tool_choice = { type: 'tool', name: intent.name };
    break;
  }

  return request;
};
