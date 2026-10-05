import { klona } from 'klona/json';

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
  type GeminiGenerateContentToolCallIds,
  geminiGenerateContentVisibleText,
} from '../shared/gemini-generate-content-via/gemini-generate-content.ts';
import { geminiFunctionParameters, geminiResponseSchema } from '../shared/gemini-generate-content-via/schema.ts';
import { restoreAnthropicMessagesThinBlocks } from '../shared/via-anthropic-messages/assistant-message-private.ts';
import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from '../shared/via-anthropic-messages/cache-breakpoints.ts';
import { anthropicMessagesToolInputSchema } from '../shared/via-anthropic-messages/tool-input-schema.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import {
  ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
  type AnthropicMessagesAssistantInputContentBlock,
  type AnthropicMessagesImageBlock,
  type AnthropicMessagesPayload,
  type AnthropicMessagesTextBlockParam,
  type AnthropicMessagesTool,
  type AnthropicMessagesUserContentBlock,
} from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentContent, GeminiGenerateContentPayload, GeminiGenerateContentGenerationConfig, GeminiGenerateContentPart, GeminiGenerateContentThinkingConfig } from '@floway-dev/protocols/gemini-generate-content';
import { OpenAIChatCompletionsAssistantMessagePrivate } from '@floway-dev/protocols/openai-chat-completions';

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

  (content.parts ?? []).forEach((part, partIndex) => {
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

const buildAssistantMessage = (content: GeminiGenerateContentContent, turnIndex: number, unmatchedToolCallIds: GeminiGenerateContentToolCallIds, privateState?: OpenAIChatCompletionsAssistantMessagePrivate): AnthropicMessagesPayload['messages'][number] | null => {
  const blocks: AnthropicMessagesAssistantInputContentBlock[] = [];
  if (privateState !== undefined) blocks.push(...restoreAnthropicMessagesThinBlocks({ role: 'assistant', content: null, [OpenAIChatCompletionsAssistantMessagePrivate]: privateState }) ?? []);

  (content.parts ?? []).forEach((part, partIndex) => {
    const kind = geminiGenerateContentPartKind(part);
    switch (kind) {
    case null:
      return;
    case 'function_call': {
      const { call, id } = geminiGenerateContentFunctionCallPart(part, unmatchedToolCallIds, turnIndex, partIndex)!;
      blocks.push({
        type: 'tool_use',
        id,
        name: call.name,
        input: klona(call.args),
      });
      return;
    }
    case 'text': {
      const text = geminiGenerateContentVisibleText(part);
      if (text !== null) {
        blocks.push({ type: 'text', text });
      }
      return;
    }
    default:
      throw new TranslatorInputError(`"${kind}" parts are not supported in model content.`);
    }
  });

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
    request.stop_sequences = klona(generationConfig.stopSequences);
  }
  const schema = geminiResponseSchema(generationConfig);
  return schema === undefined ? {} : { format: { type: 'json_schema', schema } };
};

const buildTools = (payload: GeminiGenerateContentPayload): AnthropicMessagesTool[] | undefined => {
  const tools = geminiGenerateContentFunctionDeclarations(payload, 'all').map(declaration => ({
    type: 'custom' as const,
    name: declaration.name,
    ...(declaration.description !== undefined ? { description: declaration.description } : {}),
    input_schema: anthropicMessagesToolInputSchema(geminiFunctionParameters(declaration) ?? { type: 'object', properties: {} }),
  }));

  return tools.length ? tools : undefined;
};

export const buildTargetRequest = (
  payload: GeminiGenerateContentPayload,
  model: string,
  options: { fallbackMaxOutputTokens?: number },
  decoded: ReadonlyMap<object, OpenAIChatCompletionsAssistantMessagePrivate>,
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
    const systemBlocks: AnthropicMessagesTextBlockParam[] = [{ type: 'text', text: system }];
    applyLastSystemCacheBreakpoint(systemBlocks);
    request.system = systemBlocks;
  }

  payload.contents?.forEach((content, turnIndex) => {
    let message: AnthropicMessagesPayload['messages'][number] | null;
    switch (content.role) {
    case 'model':
      message = buildAssistantMessage(content, turnIndex, unmatchedToolCallIds, decoded.get(content));
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
