import { klona } from 'klona/json';

import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { SidecarCodec } from '../../../types.ts';
import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from '../../anthropic-messages/as-target/cache-breakpoints.ts';
import { anthropicMessagesToolInputSchema } from '../../anthropic-messages/as-target/tool-input-schema.ts';
import { geminiGenerateContentInlineData, geminiGenerateContentPartKind, geminiGenerateContentPartText, geminiGenerateContentText, geminiGenerateContentThoughtText, geminiGenerateContentVisibleText } from '../as-source/content.ts';
import { partitionGeminiGenerateContentTurns } from '../as-source/conversation-turns.ts';
import { collectGeminiGenerateContentReplayContents, hasGeminiGenerateContentThoughtSignature, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from '../as-source/round-trip.ts';
import { geminiFunctionParameters, geminiResponseSchema } from '../as-source/schema.ts';
import { geminiGenerateContentFunctionCallingIntent, geminiGenerateContentFunctionCallPart, geminiGenerateContentFunctionDeclarations, geminiGenerateContentFunctionResponsePart, type GeminiGenerateContentToolCallIds } from '../as-source/tools.ts';
import {
  ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
  type AnthropicMessagesAssistantInputContentBlock,
  type AnthropicMessagesPayload,
  type AnthropicMessagesTextBlockParam,
  type AnthropicMessagesTool,
  type AnthropicMessagesUserContentBlock,
} from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentContent, GeminiGenerateContentPayload, GeminiGenerateContentGenerationConfig, GeminiGenerateContentPart, GeminiGenerateContentThinkingConfig } from '@floway-dev/protocols/gemini-generate-content';

const inlineDataToContentBlock = (part: GeminiGenerateContentPart): AnthropicMessagesUserContentBlock | null => {
  const inlineData = geminiGenerateContentInlineData(part);
  if (inlineData === null) return null;

  switch (inlineData.kind) {
  case 'image':
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: inlineData.mimeType,
        data: inlineData.data,
      },
    };
  case 'pdf':
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: inlineData.mimeType,
        data: inlineData.data,
      },
    };
  case 'audio':
  case 'unsupported':
    throw new TranslatorInputError(`Cannot translate Gemini generateContent inlineData MIME type '${inlineData.mimeType}' to Anthropic Messages.`);
  }
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
      const inlineData = inlineDataToContentBlock(part);
      if (inlineData) blocks.push(inlineData);
      return;
    }
    default:
      throw new TranslatorInputError(`"${kind}" parts are not supported in user content.`);
    }
  });

  return blocks.length ? { role: 'user', content: blocks } : (content.parts?.length ?? 0) === 0 ? { role: 'user', content: '' } : null;
};

const buildAssistantMessage = (content: GeminiGenerateContentContent, turnIndex: number, unmatchedToolCallIds: GeminiGenerateContentToolCallIds): AnthropicMessagesPayload['messages'][number] | null => {
  if (hasGeminiGenerateContentThoughtSignature(content)) {
    warnDroppedUnrecognizedAssistantReasoning('geminiGenerateContent', 'anthropicMessages');
  }
  const blocks: AnthropicMessagesAssistantInputContentBlock[] = [];
  const parts = (content.parts ?? []).flatMap(part => {
    const kind = geminiGenerateContentPartKind(part);
    return kind === null ? [] : [{ kind, part }];
  });

  parts.forEach(({ kind, part }, partIndex) => {
    switch (kind) {
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
      const thoughtText = geminiGenerateContentThoughtText(part);
      if (thoughtText !== null) {
        blocks.push({ signature: '', type: 'thinking', thinking: thoughtText });
        return;
      }
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

  return blocks.length ? { role: 'assistant', content: blocks } : (content.parts?.length ?? 0) === 0 ? { role: 'assistant', content: '' } : null;
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

  const effort = thinkingConfig?.thinkingLevel;
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

export const buildTargetRequest = async (
  payload: GeminiGenerateContentPayload,
  model: string,
  codec: SidecarCodec,
  options: { fallbackMaxOutputTokens: number | undefined },
): Promise<AnthropicMessagesPayload> => {
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
  const unmatchedToolCallIds: GeminiGenerateContentToolCallIds = Object.create(null);

  const system = geminiGenerateContentText(payload.systemInstruction);
  if (system !== null) {
    const systemBlocks: AnthropicMessagesTextBlockParam[] = [{ type: 'text', text: system }];
    applyLastSystemCacheBreakpoint(systemBlocks);
    request.system = systemBlocks;
  }

  const restoredMessages = new Set<AnthropicMessagesPayload['messages'][number]>();
  let contentIndex = 0;
  for (const turn of partitionGeminiGenerateContentTurns(payload.contents ?? [])) {
    const roundTrip = turn.role === 'assistant' && await roundTripAssistantTurn('geminiGenerateContent', 'anthropicMessages', turn.items, codec, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest, collectGeminiGenerateContentReplayContents);
    if (!roundTrip) {
      if (turn.role === 'assistant') {
        for (const [index, content] of turn.items.entries()) {
          const message = buildAssistantMessage(content, contentIndex + index, unmatchedToolCallIds);
          if (message) request.messages.push(message);
        }
      } else for (const [index, content] of turn.items.entries()) {
        if (content.role !== 'user' && content.role !== undefined) throw new TranslatorInputError(`"${(content as { role: string }).role}" is not a supported content role.`);
        const message = buildUserMessage(content, contentIndex + index, unmatchedToolCallIds);
        if (message) request.messages.push(message);
      }
    } else {
      request.messages.push(roundTrip.turn);
      restoredMessages.add(roundTrip.turn);
      if (Array.isArray(roundTrip.turn.content)) for (const block of roundTrip.turn.content) {
        if (block.type !== 'tool_use' && block.type !== 'server_tool_use') continue;
        unmatchedToolCallIds[block.name] ??= [];
        unmatchedToolCallIds[block.name].push(block.id);
      }
    }
    contentIndex += turn.items.length;
  }

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
  applyLastMessageCacheBreakpoint(request.messages.filter(message => !restoredMessages.has(message)));

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
