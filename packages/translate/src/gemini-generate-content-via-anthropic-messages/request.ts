import {
  geminiGenerateContentFunctionCallingIntent,
  geminiGenerateContentFunctionCallPart,
  geminiGenerateContentFunctionDeclarations,
  geminiGenerateContentFunctionResponsePart,
  geminiGenerateContentInlineData,
  geminiGenerateContentPartKind,
  geminiGenerateContentPartText,
  geminiGenerateContentText,
  geminiGenerateContentThinkingLevelEffort,
  geminiGenerateContentThoughtText,
  type GeminiGenerateContentToolCallIds,
  geminiGenerateContentVisibleText,
} from '../shared/gemini-generate-content-via/gemini-generate-content.ts';
import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from '../shared/via-anthropic-messages/cache-breakpoints.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import {
  ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
  type AnthropicMessagesAssistantContentBlock,
  type AnthropicMessagesImageBlock,
  type AnthropicMessagesPayload,
  type AnthropicMessagesTextBlock,
  type AnthropicMessagesTool,
  type AnthropicMessagesUserContentBlock,
} from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentContent, GeminiGenerateContentPayload, GeminiGenerateContentGenerationConfig, GeminiGenerateContentPart, GeminiGenerateContentThinkingConfig } from '@floway-dev/protocols/gemini-generate-content';

const inlineDataToImageBlock = (part: GeminiGenerateContentPart): AnthropicMessagesImageBlock | null => {
  const inlineData = geminiGenerateContentInlineData(part);
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

const buildUserMessage = (content: GeminiGenerateContentContent, turnIndex: number, unmatchedToolCallIds: GeminiGenerateContentToolCallIds): AnthropicMessagesPayload['messages'][number] | null => {
  const blocks: AnthropicMessagesUserContentBlock[] = [];

  content.parts.forEach((part, partIndex) => {
    const kind = geminiGenerateContentPartKind(part);
    switch (kind) {
    case null:
      return;
    case 'function_response': {
      const { response, id } = geminiGenerateContentFunctionResponsePart(part, unmatchedToolCallIds, turnIndex, partIndex, 'last')!;
      blocks.push({
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify(response.response),
      });
      return;
    }
    case 'text': {
      const text = geminiGenerateContentPartText(part);
      if (text !== null) blocks.push({ type: 'text', text });
      return;
    }
    case 'inline_data': {
      const image = inlineDataToImageBlock(part);
      if (image) blocks.push(image);
      return;
    }
    default:
      throw new TranslatorInputError(`"${kind}" parts are not supported in user content.`);
    }
  });

  return blocks.length ? { role: 'user', content: blocks } : null;
};

const attachSignatureToThinking = (
  blocks: AnthropicMessagesAssistantContentBlock[],
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

const buildAssistantMessage = (content: GeminiGenerateContentContent, turnIndex: number, unmatchedToolCallIds: GeminiGenerateContentToolCallIds): AnthropicMessagesPayload['messages'][number] | null => {
  const blocks: AnthropicMessagesAssistantContentBlock[] = [];
  let firstThinkingIndex: number | undefined;
  let firstActionSignature: string | undefined;
  let firstSignedActionIndex: number | undefined;

  content.parts.forEach((part, partIndex) => {
    if (part.thoughtSignature !== undefined && firstActionSignature === undefined) {
      firstActionSignature = part.thoughtSignature;
    }

    const kind = geminiGenerateContentPartKind(part);
    switch (kind) {
    case null:
      return;
    case 'function_call': {
      const { call, id } = geminiGenerateContentFunctionCallPart(part, unmatchedToolCallIds, turnIndex, partIndex)!;
      if (part.thoughtSignature !== undefined) firstSignedActionIndex ??= blocks.length;
      blocks.push({
        type: 'tool_use',
        id,
        name: call.name,
        input: call.args,
      });
      return;
    }
    case 'text': {
      const thoughtText = geminiGenerateContentThoughtText(part);
      if (thoughtText !== null) {
        firstThinkingIndex ??= blocks.length;
        blocks.push({ type: 'thinking', thinking: thoughtText });
        return;
      }
      const text = geminiGenerateContentVisibleText(part);
      if (text !== null) {
        if (part.thoughtSignature !== undefined) firstSignedActionIndex ??= blocks.length;
        blocks.push({ type: 'text', text });
      }
      return;
    }
    default:
      throw new TranslatorInputError(`"${kind}" parts are not supported in model content.`);
    }
  });

  attachSignatureToThinking(blocks, firstActionSignature, firstThinkingIndex, firstSignedActionIndex);

  return blocks.length ? { role: 'assistant', content: blocks } : null;
};

interface ThinkingConfigFields {
  thinking?: NonNullable<AnthropicMessagesPayload['thinking']>;
  outputConfig: NonNullable<AnthropicMessagesPayload['output_config']>;
}

const applyThinkingConfig = (thinkingConfig?: GeminiGenerateContentThinkingConfig): ThinkingConfigFields => {
  if (!thinkingConfig) return { outputConfig: {} };

  let thinking: ThinkingConfigFields['thinking'];
  if (thinkingConfig.thinkingBudget === -1) {
    thinking = { type: 'adaptive' };
  } else if (thinkingConfig.thinkingBudget !== undefined && thinkingConfig.thinkingBudget > 0) {
    thinking = {
      type: 'enabled',
      budget_tokens: thinkingConfig.thinkingBudget,
    };
  } else if (thinkingConfig.thinkingBudget === 0) {
    thinking = { type: 'disabled' };
  }

  const effort = geminiGenerateContentThinkingLevelEffort(thinkingConfig);
  return {
    ...(thinking !== undefined ? { thinking } : {}),
    outputConfig: effort !== undefined ? { effort } : {},
  };
};

const applyGenerationConfig = (request: AnthropicMessagesPayload, generationConfig: GeminiGenerateContentGenerationConfig | undefined, fallbackMaxOutputTokens: number): NonNullable<AnthropicMessagesPayload['output_config']> => {
  request.max_tokens = generationConfig?.maxOutputTokens ?? fallbackMaxOutputTokens;

  if (!generationConfig) return {};

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
  // Gemini generateContent's `responseSchema` is the bare JSON Schema; Anthropic carries it
  // as `output_config.format = { type: 'json_schema', schema }`. `responseMimeType:
  // application/json` without a schema has no Anthropic equivalent and is
  // dropped — the routing fallback degrades gracefully rather than fails.
  return generationConfig.responseSchema !== undefined
    ? { format: { type: 'json_schema', schema: generationConfig.responseSchema as Record<string, unknown> } }
    : {};
};

const inputSchemaForDeclaration = (parameters: Record<string, unknown> | undefined): Record<string, unknown> => {
  if (parameters !== undefined) return parameters;

  // AnthropicMessagesClientTool requires input_schema, so parameterless Gemini generateContent function
  // declarations use the smallest object schema rather than dropping the tool.
  return { type: 'object', properties: {} };
};

const buildTools = (payload: GeminiGenerateContentPayload): AnthropicMessagesTool[] | undefined => {
  const tools = geminiGenerateContentFunctionDeclarations(payload, 'all').map(declaration => ({
    type: 'custom' as const,
    name: declaration.name,
    ...(declaration.description !== undefined ? { description: declaration.description } : {}),
    input_schema: inputSchemaForDeclaration(declaration.parameters),
  }));

  return tools.length ? tools : undefined;
};

export const buildTargetRequest = (
  payload: GeminiGenerateContentPayload,
  model: string,
  options: { fallbackMaxOutputTokens?: number },
): AnthropicMessagesPayload => {
  // Gemini generateContent can omit maxOutputTokens, but AnthropicMessagesPayload requires max_tokens.
  // Prefer the model's advertised `/models` cap when one is known; otherwise
  // fall back to the gateway policy default shared with the other
  // `*-via-anthropic-messages` translators.
  const fallbackMaxOutputTokens = options.fallbackMaxOutputTokens ?? ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS;
  const request: AnthropicMessagesPayload = {
    model,
    stream: true,
    max_tokens: fallbackMaxOutputTokens,
    messages: [],
  };
  const unmatchedToolCallIds: GeminiGenerateContentToolCallIds = {};

  const system = geminiGenerateContentText(payload.systemInstruction);
  if (system !== null) {
    const systemBlocks: AnthropicMessagesTextBlock[] = [{ type: 'text', text: system }];
    applyLastSystemCacheBreakpoint(systemBlocks);
    request.system = systemBlocks;
  }

  payload.contents?.forEach((content, turnIndex) => {
    let message: AnthropicMessagesPayload['messages'][number] | null;
    switch (content.role) {
    case 'model':
      message = buildAssistantMessage(content, turnIndex, unmatchedToolCallIds);
      break;
    case 'user':
    case undefined:
      message = buildUserMessage(content, turnIndex, unmatchedToolCallIds);
      break;
    default:
      throw new TranslatorInputError(`"${(content as { role: string }).role}" is not a supported content role.`);
    }
    if (message) request.messages.push(message);
  });

  const generationOutputConfig = applyGenerationConfig(request, payload.generationConfig, fallbackMaxOutputTokens);
  const { thinking, outputConfig: thinkingOutputConfig } = applyThinkingConfig(payload.generationConfig?.thinkingConfig);
  const outputConfig = { ...generationOutputConfig, ...thinkingOutputConfig };
  const hasGenerationOutputConfig = Object.keys(generationOutputConfig).length > 0;
  const attachOutputConfig = (): void => {
    request.output_config = outputConfig;
  };

  // Preserve request-key insertion order: a structured-output format precedes
  // `thinking`, while an effort-only `output_config` follows it.
  if (hasGenerationOutputConfig) attachOutputConfig();
  if (thinking !== undefined) request.thinking = thinking;
  if (!hasGenerationOutputConfig && Object.keys(outputConfig).length > 0) attachOutputConfig();

  const tools = buildTools(payload);
  if (tools) request.tools = tools;
  applyLastToolCacheBreakpoint(request.tools);
  applyLastMessageCacheBreakpoint(request.messages);

  const intent = geminiGenerateContentFunctionCallingIntent(payload.toolConfig?.functionCallingConfig);
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
