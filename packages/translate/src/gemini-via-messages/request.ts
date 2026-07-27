import {
  geminiFunctionCallingIntent,
  geminiFunctionCallPart,
  geminiFunctionDeclarations,
  geminiFunctionResponsePart,
  geminiInlineData,
  geminiPartKind,
  geminiPartText,
  geminiText,
  geminiThinkingLevelEffort,
  geminiThoughtText,
  type GeminiToolCallIds,
  geminiVisibleText,
} from '../shared/gemini-via/gemini.ts';
import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from '../shared/via-messages/cache-breakpoints.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { GeminiContent, GeminiPayload, GeminiGenerationConfig, GeminiPart, GeminiThinkingConfig } from '@floway-dev/protocols/gemini';
import {
  MESSAGES_FALLBACK_MAX_TOKENS,
  type MessagesAssistantContentBlock,
  type MessagesImageBlock,
  type MessagesPayload,
  type MessagesTextBlock,
  type MessagesTool,
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

const buildUserMessage = (content: GeminiContent, turnIndex: number, unmatchedToolCallIds: GeminiToolCallIds): MessagesPayload['messages'][number] | null => {
  const blocks: MessagesUserContentBlock[] = [];

  content.parts.forEach((part, partIndex) => {
    const kind = geminiPartKind(part);
    switch (kind) {
    case null:
      return;
    case 'function_response': {
      const { response, id } = geminiFunctionResponsePart(part, unmatchedToolCallIds, turnIndex, partIndex, 'last')!;
      blocks.push({
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify(response.response),
      });
      return;
    }
    case 'text': {
      const text = geminiPartText(part);
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

const buildAssistantMessage = (content: GeminiContent, turnIndex: number, unmatchedToolCallIds: GeminiToolCallIds): MessagesPayload['messages'][number] | null => {
  const blocks: MessagesAssistantContentBlock[] = [];
  let firstThinkingIndex: number | undefined;
  let firstActionSignature: string | undefined;
  let firstSignedActionIndex: number | undefined;

  content.parts.forEach((part, partIndex) => {
    if (part.thoughtSignature !== undefined && firstActionSignature === undefined) {
      firstActionSignature = part.thoughtSignature;
    }

    const kind = geminiPartKind(part);
    switch (kind) {
    case null:
      return;
    case 'function_call': {
      const { call, id } = geminiFunctionCallPart(part, unmatchedToolCallIds, turnIndex, partIndex)!;
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
      const thoughtText = geminiThoughtText(part);
      if (thoughtText !== null) {
        firstThinkingIndex ??= blocks.length;
        blocks.push({ type: 'thinking', thinking: thoughtText });
        return;
      }
      const text = geminiVisibleText(part);
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
  thinking?: NonNullable<MessagesPayload['thinking']>;
  outputConfig: NonNullable<MessagesPayload['output_config']>;
}

const applyThinkingConfig = (thinkingConfig?: GeminiThinkingConfig): ThinkingConfigFields => {
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

  const effort = geminiThinkingLevelEffort(thinkingConfig);
  return {
    ...(thinking !== undefined ? { thinking } : {}),
    outputConfig: effort !== undefined ? { effort } : {},
  };
};

const applyGenerationConfig = (request: MessagesPayload, generationConfig: GeminiGenerationConfig | undefined, fallbackMaxOutputTokens: number): NonNullable<MessagesPayload['output_config']> => {
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
  // Gemini's `responseSchema` is the bare JSON Schema; Anthropic carries it
  // as `output_config.format = { type: 'json_schema', schema }`. `responseMimeType:
  // application/json` without a schema has no Anthropic equivalent and is
  // dropped — the routing fallback degrades gracefully rather than fails.
  return generationConfig.responseSchema !== undefined
    ? { format: { type: 'json_schema', schema: generationConfig.responseSchema as Record<string, unknown> } }
    : {};
};

const inputSchemaForDeclaration = (parameters: Record<string, unknown> | undefined): Record<string, unknown> => {
  if (parameters !== undefined) return parameters;

  // MessagesClientTool requires input_schema, so parameterless Gemini function
  // declarations use the smallest object schema rather than dropping the tool.
  return { type: 'object', properties: {} };
};

const buildTools = (payload: GeminiPayload): MessagesTool[] | undefined => {
  const tools = geminiFunctionDeclarations(payload, 'all').map(declaration => ({
    type: 'custom' as const,
    name: declaration.name,
    ...(declaration.description !== undefined ? { description: declaration.description } : {}),
    input_schema: inputSchemaForDeclaration(declaration.parameters),
  }));

  return tools.length ? tools : undefined;
};

export const buildTargetRequest = (
  payload: GeminiPayload,
  model: string,
  options: { fallbackMaxOutputTokens?: number },
): MessagesPayload => {
  // Gemini can omit maxOutputTokens, but MessagesPayload requires max_tokens.
  // Prefer the model's advertised `/models` cap when one is known; otherwise
  // fall back to the gateway policy default shared with the other
  // `*-via-messages` translators.
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
    const systemBlocks: MessagesTextBlock[] = [{ type: 'text', text: system }];
    applyLastSystemCacheBreakpoint(systemBlocks);
    request.system = systemBlocks;
  }

  payload.contents?.forEach((content, turnIndex) => {
    let message: MessagesPayload['messages'][number] | null;
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
